import { z } from "zod";
import type { OwnedProcess } from "../../process/process.js";
import type { TurnEvent } from "../harness.js";
import { JsonlLineReader } from "../jsonl.js";

const rpcIdSchema = z.union([z.string(), z.number()]);
const rpcEnvelopeSchema = z.looseObject({
  id: rpcIdSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});

export type CodexRpcEnvelope = z.infer<typeof rpcEnvelopeSchema>;

export interface CodexProtocolObserver {
  stdin(bytes: Uint8Array): void;
  stdout(bytes: Uint8Array): void;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (cause: unknown) => void;
  readonly onAccepted?: () => void;
}

interface TCodexRequest {
  readonly method: string;
  readonly params: object;
  readonly onAccepted?: () => void;
}

export interface CodexRuntimeHandlers {
  message(message: CodexRpcEnvelope): void;
  ended(cause?: unknown): void;
}

export class CodexProtocolError extends Error {}

export class CodexRpcResponseError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly rpcMessage: string,
  ) {
    super(`${method} returned RPC error ${code}: ${rpcMessage}`);
  }
}

export class CodexExchangeTimeoutError extends Error {}

/** Owns one app-server stdout iterator, decoder remainder, and client request-id
 * sequence across qualification and runtime. Runtime starts exactly once after
 * the bounded qualification exchange has finished. */
export class CodexJsonlConnection {
  private readonly reader: JsonlLineReader;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private runtimeStarted = false;

  constructor(
    private readonly process: OwnedProcess,
    private readonly observer: CodexProtocolObserver | undefined,
  ) {
    this.reader = new JsonlLineReader(process.stdout);
  }

  async qualificationRequest(method: string, params: object): Promise<unknown> {
    const id = this.nextId++;
    await this.write({ id, method, params });
    for (;;) {
      const message = await this.readMessage();
      if (message.id === undefined) continue;
      if (message.method !== undefined) {
        throw new Error(
          `unexpected server request '${message.method}' during qualification`,
        );
      }
      if (message.id !== id) {
        throw new Error(`unexpected response id '${String(message.id)}'`);
      }
      return responseResult(method, message);
    }
  }

  qualificationNotify(method: string): Promise<void> {
    return this.write({ method });
  }

  startRuntime(handlers: CodexRuntimeHandlers): void {
    if (this.runtimeStarted) {
      throw new Error("Codex runtime reader already started");
    }
    this.runtimeStarted = true;
    void this.consume(handlers);
  }

  request(method: string, params: object): Promise<unknown> {
    return this.sendRequest({ method, params });
  }

  requestControl(options: TCodexRequest): Promise<unknown> {
    return this.sendRequest(options);
  }

  private sendRequest(options: TCodexRequest): Promise<unknown> {
    if (!this.runtimeStarted) {
      return Promise.reject(new Error("Codex runtime reader is not started"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        method: options.method,
        resolve,
        reject,
        onAccepted: options.onAccepted,
      });
      void this.write({
        id,
        method: options.method,
        params: options.params,
      }).catch((cause) => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        pending.reject(cause);
      });
    });
  }

  respondToServerRequest(id: string | number, result: object): Promise<void> {
    if (!this.runtimeStarted) {
      return Promise.reject(new Error("Codex runtime reader is not started"));
    }
    return this.write({ id, result });
  }

  private async consume(handlers: CodexRuntimeHandlers): Promise<void> {
    try {
      for (;;) {
        const message = await this.readMessage();
        if (message.id !== undefined && message.method === undefined) {
          this.acceptResponse(message);
          continue;
        }
        handlers.message(message);
      }
    } catch (cause) {
      for (const pending of this.pending.values()) pending.reject(cause);
      this.pending.clear();
      handlers.ended(cause);
    }
  }

  private acceptResponse(message: CodexRpcEnvelope): void {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    try {
      const result = responseResult(pending.method, message);
      pending.onAccepted?.();
      pending.resolve(result);
    } catch (cause) {
      pending.reject(cause);
    }
  }

  private write(message: object): Promise<void> {
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    this.observer?.stdin(bytes);
    return this.process.writeStdin(bytes);
  }

  private async readMessage(): Promise<CodexRpcEnvelope> {
    const line = await this.nextLine();
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (cause) {
      throw new CodexProtocolError("Codex emitted malformed JSON", { cause });
    }
    const parsed = rpcEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new CodexProtocolError(
        `Codex emitted an incompatible RPC envelope: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private async nextLine(): Promise<string> {
    for (;;) {
      const next = await this.reader.next();
      if (next.kind === "line") {
        if (next.value.trim().length > 0) {
          this.observer?.stdout(new TextEncoder().encode(next.raw));
          return next.value;
        }
        continue;
      }
      if (next.kind === "truncated" && next.value.trim().length > 0) {
        throw new CodexProtocolError("Codex emitted a truncated JSON frame");
      }
      throw new Error("Codex app-server stdout closed");
    }
  }
}

function responseResult(method: string, message: CodexRpcEnvelope): unknown {
  if (message.error !== undefined) {
    throw new CodexRpcResponseError(
      method,
      message.error.code,
      message.error.message,
    );
  }
  if (!("result" in message)) {
    throw new Error(`${method} response has neither result nor error`);
  }
  return message.result;
}

const threadResultSchema = z.looseObject({
  model: z.string().min(1),
  thread: z.looseObject({ id: z.string().min(1) }),
});

const turnStartResultSchema = z.looseObject({
  turn: z.looseObject({ id: z.string().min(1) }),
});
const turnSteerResultSchema = z.looseObject({
  turnId: z.string().min(1),
});
const turnInterruptResultSchema = z.looseObject({});

export function parseThreadStartResult(value: unknown): {
  readonly threadId: string;
  readonly model: string;
} {
  const result = parseResult(value, threadResultSchema, "thread/start");
  return { threadId: result.thread.id, model: result.model };
}

export function parseThreadResumeResult(value: unknown): {
  readonly threadId: string;
  readonly model: string;
} {
  const result = parseResult(value, threadResultSchema, "thread/resume");
  return { threadId: result.thread.id, model: result.model };
}

export function parseTurnStartResult(value: unknown): string {
  return parseResult(value, turnStartResultSchema, "turn/start").turn.id;
}

export function parseTurnSteerResult(value: unknown): string {
  return parseResult(value, turnSteerResultSchema, "turn/steer").turnId;
}

export function parseTurnInterruptResult(value: unknown): void {
  parseResult(value, turnInterruptResultSchema, "turn/interrupt");
}

const correlatedParamsSchema = z.looseObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
});
const turnSchema = z
  .looseObject({
    id: z.string().min(1),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    error: z
      .looseObject({ message: z.string().min(1) })
      .nullable()
      .optional(),
  })
  .superRefine((turn, context) => {
    if (turn.status === "failed" && turn.error == null) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "a failed Turn must carry its terminal error",
      });
    }
  });
const turnStartedSchema = z.looseObject({
  threadId: z.string().min(1),
  turn: turnSchema,
});
const turnCompletedSchema = turnStartedSchema;
const agentDeltaSchema = correlatedParamsSchema.extend({
  delta: z.string(),
});
const itemLifecycleSchema = correlatedParamsSchema.extend({
  item: z.unknown(),
});
const commandItemSchema = z.looseObject({
  command: z.string(),
  status: z.enum(["inProgress", "completed", "failed", "declined"]),
});
const fileChangeItemSchema = z.looseObject({
  changes: z.array(
    z.looseObject({
      path: z.string().min(1),
      kind: z.looseObject({
        type: z.enum(["add", "delete", "update"]),
        move_path: z.string().nullable().optional(),
      }),
    }),
  ),
  status: z.enum(["inProgress", "completed", "failed", "declined"]),
});
const mcpItemSchema = z.looseObject({
  server: z.string().min(1),
  tool: z.string().min(1),
  status: z.enum(["inProgress", "completed", "failed"]),
});
const collabItemSchema = z.looseObject({
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
});
const dynamicToolItemSchema = z.looseObject({
  tool: z.string().min(1),
  status: z.enum(["inProgress", "completed", "failed"]),
});
const webSearchItemSchema = z.looseObject({ query: z.string() });
const imageViewItemSchema = z.looseObject({ path: z.string() });
const imageGenerationItemSchema = z.looseObject({ status: z.string() });
const errorNotificationSchema = correlatedParamsSchema.extend({
  error: z.looseObject({ message: z.string().min(1) }),
  willRetry: z.boolean(),
});
const commandApprovalSchema = correlatedParamsSchema.extend({
  itemId: z.string().min(1),
  command: z.string().min(1),
  kind: z.literal("command").optional(),
});
const fileApprovalSchema = correlatedParamsSchema.extend({
  itemId: z.string().min(1),
});
const requestResolvedSchema = z.looseObject({
  requestId: rpcIdSchema,
  threadId: z.string().min(1),
});

export type CodexRuntimeNotification =
  | {
      readonly kind: "turn-started";
      readonly threadId: string;
      readonly turnId: string;
    }
  | {
      readonly kind: "turn-completed";
      readonly threadId: string;
      readonly turnId: string;
      readonly status: "completed" | "interrupted" | "failed" | "inProgress";
      readonly error?: string;
    }
  | {
      readonly kind: "preview";
      readonly threadId: string;
      readonly turnId: string;
      readonly delta: string;
    }
  | {
      readonly kind: "item-event";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly event?: TurnEvent;
      readonly approvalInput?: string;
    }
  | {
      readonly kind: "error";
      readonly threadId: string;
      readonly turnId: string;
      readonly message: string;
      readonly willRetry: boolean;
    }
  | { readonly kind: "activity"; readonly description: string }
  | {
      readonly kind: "approval-request";
      readonly nativeRequestId: string | number;
      readonly threadId: string;
      readonly turnId: string;
      readonly tool: "command" | "file-change";
      readonly itemId: string;
      readonly input?: string;
    }
  | {
      readonly kind: "server-request-resolved";
      readonly nativeRequestId: string | number;
      readonly threadId: string;
    }
  | {
      readonly kind: "unsupported-server-request";
      readonly method: string;
    };

export function parseRuntimeNotification(
  message: CodexRpcEnvelope,
): CodexRuntimeNotification | undefined {
  const method = message.method;
  if (method === undefined) return undefined;
  if (message.id !== undefined) {
    if (method === "item/commandExecution/requestApproval") {
      const params = parseResult(message.params, commandApprovalSchema, method);
      return {
        kind: "approval-request",
        nativeRequestId: message.id,
        threadId: params.threadId,
        turnId: params.turnId,
        tool: "command",
        itemId: params.itemId,
        input: params.command,
      };
    }
    if (method === "item/fileChange/requestApproval") {
      const params = parseResult(message.params, fileApprovalSchema, method);
      return {
        kind: "approval-request",
        nativeRequestId: message.id,
        threadId: params.threadId,
        turnId: params.turnId,
        tool: "file-change",
        itemId: params.itemId,
      };
    }
    return { kind: "unsupported-server-request", method };
  }
  switch (method) {
    case "turn/started": {
      const params = parseResult(message.params, turnStartedSchema, method);
      return {
        kind: "turn-started",
        threadId: params.threadId,
        turnId: params.turn.id,
      };
    }
    case "turn/completed": {
      const params = parseResult(message.params, turnCompletedSchema, method);
      return {
        kind: "turn-completed",
        threadId: params.threadId,
        turnId: params.turn.id,
        status: params.turn.status,
        ...(params.turn.error?.message !== undefined
          ? { error: params.turn.error.message }
          : {}),
      };
    }
    case "item/agentMessage/delta": {
      const params = parseResult(message.params, agentDeltaSchema, method);
      return {
        kind: "preview",
        threadId: params.threadId,
        turnId: params.turnId,
        delta: params.delta,
      };
    }
    case "item/started":
    case "item/completed": {
      const params = parseResult(message.params, itemLifecycleSchema, method);
      return {
        kind: "item-event",
        threadId: params.threadId,
        turnId: params.turnId,
        ...normalizeItem(params.item, method === "item/started"),
      };
    }
    case "error": {
      const params = parseResult(
        message.params,
        errorNotificationSchema,
        method,
      );
      return {
        kind: "error",
        threadId: params.threadId,
        turnId: params.turnId,
        message: params.error.message,
        willRetry: params.willRetry,
      };
    }
    case "serverRequest/resolved": {
      const params = parseResult(message.params, requestResolvedSchema, method);
      return {
        kind: "server-request-resolved",
        nativeRequestId: params.requestId,
        threadId: params.threadId,
      };
    }
    default:
      return {
        kind: "activity",
        description: `Codex activity: ${method}`,
      };
  }
}

function normalizeItem(
  value: unknown,
  started: boolean,
): {
  readonly itemId: string;
  readonly event?: TurnEvent;
  readonly approvalInput?: string;
} {
  const item = parseResult(
    value,
    z.looseObject({ id: z.string().min(1), type: z.string().min(1) }),
    "item lifecycle",
  );
  const type = item.type;
  if (type === "reasoning") return { itemId: item.id };
  if (type === "userMessage") {
    parseResult(
      item,
      z.looseObject({ content: z.array(z.unknown()) }),
      "userMessage item",
    );
    return { itemId: item.id };
  }
  if (type === "agentMessage") {
    const message = parseResult(
      item,
      z.looseObject({ text: z.string() }),
      "agentMessage item",
    );
    return {
      itemId: item.id,
      ...(!started
        ? {
            event: {
              kind: "assistant-content",
              content: message.text,
            } as const,
          }
        : {}),
    };
  }
  const phase = started ? "started" : "completed";
  switch (type) {
    case "commandExecution": {
      const command = parseResult(
        item,
        commandItemSchema,
        "commandExecution item",
      );
      return {
        itemId: item.id,
        event: toolActivity("command", phase, command.command),
      };
    }
    case "fileChange": {
      const fileChange = parseResult(
        item,
        fileChangeItemSchema,
        "fileChange item",
      );
      return {
        itemId: item.id,
        event: toolActivity(
          "file-change",
          phase,
          changeSummary(fileChange.changes.length),
        ),
        approvalInput: fileChangeApprovalInput(fileChange.changes),
      };
    }
    case "mcpToolCall": {
      const call = parseResult(item, mcpItemSchema, "mcpToolCall item");
      return {
        itemId: item.id,
        event: toolActivity(
          `mcp:${call.server}/${call.tool}`,
          phase,
          call.status,
        ),
      };
    }
    case "collabAgentToolCall": {
      const call = parseResult(
        item,
        collabItemSchema,
        "collabAgentToolCall item",
      );
      return {
        itemId: item.id,
        event: toolActivity("subagent", phase, call.status),
      };
    }
    case "dynamicToolCall": {
      const call = parseResult(
        item,
        dynamicToolItemSchema,
        "dynamicToolCall item",
      );
      return {
        itemId: item.id,
        event: toolActivity(`dynamic:${call.tool}`, phase, call.status),
      };
    }
    case "webSearch": {
      const search = parseResult(item, webSearchItemSchema, "webSearch item");
      return {
        itemId: item.id,
        event: toolActivity("web-search", phase, search.query),
      };
    }
    case "imageView": {
      const image = parseResult(item, imageViewItemSchema, "imageView item");
      return {
        itemId: item.id,
        event: toolActivity("image-view", phase, image.path),
      };
    }
    case "imageGeneration": {
      const image = parseResult(
        item,
        imageGenerationItemSchema,
        "imageGeneration item",
      );
      return {
        itemId: item.id,
        event: toolActivity("image-generation", phase, image.status),
      };
    }
    default:
      return {
        itemId: item.id,
        event: {
          kind: "activity",
          description: `Codex ${type} ${phase}`,
        },
      };
  }
}

function fileChangeApprovalInput(
  changes: z.infer<typeof fileChangeItemSchema>["changes"],
): string {
  return changes
    .map((change) => {
      if (change.kind.type !== "update" || change.kind.move_path == null) {
        return `${change.kind.type} ${change.path}`;
      }
      return `move ${change.path} to ${change.kind.move_path}`;
    })
    .join("; ");
}

function toolActivity(
  tool: string,
  phase: "started" | "completed",
  summary: string | undefined,
): TurnEvent {
  return {
    kind: "tool-activity",
    activity: { tool, phase, summary: summary ?? `${tool} ${phase}` },
  };
}

function changeSummary(changes: number): string {
  return `${changes} file change${changes === 1 ? "" : "s"}`;
}

function parseResult<T>(
  value: unknown,
  schema: z.ZodType<T>,
  method: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${method} returned incompatible data: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export async function boundedCodexExchange<T>(options: {
  readonly operation: () => Promise<T>;
  readonly timeoutMs: number;
  readonly label: string;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CodexExchangeTimeoutError(`${options.label} timed out`));
    }, options.timeoutMs);
  });
  try {
    return await Promise.race([options.operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
