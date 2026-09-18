// The Claude Code stream-json protocol model — private to the Claude Code Adapter
// (#127 D1, A30). Every frame another vendor's CLI writes on stdout is read here
// and nowhere else: each known frame type has one schema, parsed per frame, and
// the pure readers below turn a parsed frame into Secant's own event facts. The
// Adapter body (`claude-code.ts`) dispatches on the parsed frame and mutates Turn
// state; it never touches a raw field.
//
// Parsing is deliberately lenient, exactly as the hand-rolled readers were: an
// unknown frame type, or a known type whose parse fails, is reported as generic
// activity and is never protocol corruption. Only the fields dispatch iterates
// over are structurally required (a message's content array, a stream event's
// object); every other field falls back to "absent" when its type is not the
// expected one (`.catch(undefined)`), so a new or reshaped field in a future
// Claude Code degrades one fact rather than the Turn. Unknown fields pass
// through (`looseObject`) so the readers keep seeing the whole frame.

import { z } from "zod";
import type {
  RecoveryCoordinate,
  SessionFacts,
  TurnEvent,
  TurnRequest,
  UsageObservation,
} from "../harness.js";

// --- Schemas -----------------------------------------------------------------

/** A string-valued field that is absent when missing or of another type. */
const lenientString = z.string().optional().catch(undefined);

/** `system` / `init`: the per-process handshake echoing the Session id. */
const InitFrame = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: lenientString,
  model: lenientString,
});
export type InitFrame = z.infer<typeof InitFrame>;

/** One block of an `assistant` or `user` message. Every field is lenient: a
 *  block whose fields are not the expected type is simply a block without them,
 *  and dispatch skips it the way the untyped reader did. */
const ContentBlock = z.looseObject({
  type: lenientString,
  text: lenientString,
  name: lenientString,
  id: lenientString,
  tool_use_id: lenientString,
  input: z.unknown(),
  content: z.unknown(),
});
export type ContentBlock = z.infer<typeof ContentBlock>;

/** `assistant` and `user` frames share one shape: a message whose content is a
 *  block array. The array is the one structural requirement. */
const MessageFrame = z.looseObject({
  type: z.string(),
  message: z.looseObject({ content: z.array(z.unknown()) }),
  parent_tool_use_id: z.string().nullable().optional().catch(undefined),
});
export type MessageFrame = z.infer<typeof MessageFrame>;
const AssistantFrame = MessageFrame.extend({ type: z.literal("assistant") });
const UserFrame = MessageFrame.extend({ type: z.literal("user") });

/** `stream_event`: a partial-message event; only `text_delta` carries a preview. */
const StreamEventFrame = z.looseObject({
  type: z.literal("stream_event"),
  event: z.looseObject({
    delta: z
      .looseObject({ type: lenientString, text: lenientString })
      .optional()
      .catch(undefined),
  }),
});
export type StreamEventFrame = z.infer<typeof StreamEventFrame>;

/** `result`: the one authoritative Turn result. Only the type is structural: a
 *  result frame always settles the Turn, and a missing or mistyped `subtype`
 *  settles it `failed` as `unknown-result` exactly as the untyped reader did,
 *  rather than leaving the Turn to be lost when the process later closes. */
const ResultFrame = z.looseObject({
  type: z.literal("result"),
  subtype: lenientString,
  is_error: z.boolean().optional().catch(undefined),
  result: lenientString,
});
export type ResultFrame = z.infer<typeof ResultFrame>;

const TelemetryFrame = z.looseObject({ type: z.literal("telemetry") });

/** A frame the Adapter dispatches on. `type` is the raw frame type (for the
 *  generic-activity description); a known type whose schema failed, and any
 *  unknown type, arrive as `other`. */
export type ParsedFrame =
  | { readonly kind: "init"; readonly type: string; readonly frame: InitFrame }
  | {
      readonly kind: "assistant";
      readonly type: string;
      readonly frame: MessageFrame;
    }
  | {
      readonly kind: "user";
      readonly type: string;
      readonly frame: MessageFrame;
    }
  | {
      readonly kind: "stream-event";
      readonly type: string;
      readonly frame: StreamEventFrame;
    }
  | {
      readonly kind: "result";
      readonly type: string;
      readonly frame: ResultFrame;
    }
  | { readonly kind: "telemetry"; readonly type: string }
  | { readonly kind: "other"; readonly type: string | undefined };

/** Parse one decoded stdout line. Non-object JSON (a bare value or array) is
 *  not a frame and yields `undefined`, as the untyped reader skipped it. */
export function parseFrame(value: unknown): ParsedFrame | undefined {
  if (!isRecord(value)) return undefined;
  const type = stringField(value, "type");
  if (type === "system" && stringField(value, "subtype") === "init") {
    const init = InitFrame.safeParse(value);
    return init.success
      ? { kind: "init", type, frame: init.data }
      : { kind: "other", type };
  }
  switch (type) {
    case "assistant": {
      const parsed = AssistantFrame.safeParse(value);
      return parsed.success
        ? { kind: "assistant", type, frame: parsed.data }
        : { kind: "other", type };
    }
    case "user": {
      const parsed = UserFrame.safeParse(value);
      return parsed.success
        ? { kind: "user", type, frame: parsed.data }
        : { kind: "other", type };
    }
    case "stream_event": {
      const parsed = StreamEventFrame.safeParse(value);
      return parsed.success
        ? { kind: "stream-event", type, frame: parsed.data }
        : { kind: "other", type };
    }
    case "result": {
      const parsed = ResultFrame.safeParse(value);
      return parsed.success
        ? { kind: "result", type, frame: parsed.data }
        : { kind: "other", type };
    }
    case "telemetry":
      return TelemetryFrame.safeParse(value).success
        ? { kind: "telemetry", type }
        : { kind: "other", type };
    default:
      return { kind: "other", type };
  }
}

// --- The Turn encoder ----------------------------------------------------------

export function encodeTurn(request: TurnRequest): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: request.input.text },
      parent_tool_use_id: null,
    })}\n`,
  );
}

// --- Readers -------------------------------------------------------------------

/** The message's content blocks that are objects; anything else in the array is
 *  skipped, as before. */
export function contentBlocks(frame: MessageFrame): ContentBlock[] {
  return frame.message.content.flatMap((block) => {
    const parsed = ContentBlock.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}

export function sessionFacts(
  frame: Record<string, unknown>,
  coordinate: RecoveryCoordinate,
): SessionFacts {
  const tools = Array.isArray(frame.tools)
    ? frame.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const mcp = Array.isArray(frame.mcp_servers)
    ? frame.mcp_servers.filter(isRecord).flatMap((server) => {
        const name = stringField(server, "name");
        const status = stringField(server, "status");
        return name === undefined || status === undefined
          ? []
          : [{ name, status }];
      })
    : [];
  const executableVersion = stringField(frame, "claude_code_version");
  return {
    recoveryCoordinate: coordinate,
    tools,
    mcp,
    ...(executableVersion !== undefined ? { executableVersion } : {}),
  };
}

export function usageObservation(
  frame: Record<string, unknown>,
): UsageObservation | undefined {
  const parts: string[] = [];
  if (isRecord(frame.usage)) {
    const input = numberField(frame.usage, "input_tokens");
    const output = numberField(frame.usage, "output_tokens");
    if (input !== undefined) parts.push(`input ${input}`);
    if (output !== undefined) parts.push(`output ${output} tokens`);
  }
  const cost = numberField(frame, "total_cost_usd");
  if (cost !== undefined) parts.push(`cost estimate USD ${cost}`);
  if (parts.length === 0) return undefined;
  return {
    estimate: true,
    summary: parts.join(", ").replace(", cost", "; cost"),
  };
}

export function genericActivity(type: string | undefined): TurnEvent {
  return {
    kind: "activity",
    description: `Claude Code activity: ${type ?? "unknown"}`,
  };
}

/** Claude Code reports a not-logged-in run as its stdout result (research:
 *  "missing authentication ... emitted as the stdout result"). No typed auth field
 *  exists in the documented print-mode contract, so this recognises the documented
 *  not-logged-in remediation phrasings only — bare words like "unauthorized" or
 *  "credential" are deliberately excluded so a task result that merely mentions
 *  them keeps its real diagnostics rather than being masked by the login message.
 *  #115's recording pinned the signal: a not-logged-in run returns `subtype:"success"`
 *  with `result:"Not logged in · Please run /login"`, so this is checked before the
 *  success branch. The matched text is never surfaced — only `AUTHENTICATION_REQUIRED`. */
export function isAuthenticationResult(
  frame: Record<string, unknown>,
): boolean {
  const text = [
    stringField(frame, "subtype") ?? "",
    stringField(frame, "result") ?? "",
    stringField(frame, "error") ?? "",
  ].join(" ");
  return /\bnot\s+logged\s+in\b|please (run \/login|log ?in)|\binvalid api key\b|\bauthentication (required|failed|error)\b|\bnot authenticated\b/i.test(
    text,
  );
}

// --- Field accessors (the only place in the Adapter that reads a raw field) ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  return optionalString(value[field]);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(
  value: Record<string, unknown>,
  field: string,
): number | undefined {
  const found = value[field];
  return typeof found === "number" && Number.isFinite(found)
    ? found
    : undefined;
}
