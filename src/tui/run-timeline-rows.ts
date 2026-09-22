import stringWidth from "string-width";
import type {
  RunLiveOverlay,
  RunTimelineEvent,
  RunView,
} from "../application/projection-port.js";
import { RUN_TIMELINE_TRUNCATION_MARKER } from "../application/projection-port.js";
import { clip } from "./clip.js";

/** One single-line row in the Workbench's combined durable + live timeline. */
export interface TimelineRow {
  readonly key: string;
  readonly text: string;
}

/** Join authoritative history with replaceable live Turn rows. Durable tool rows
 * remain the ordered history; current activity, preview, context, and usage are
 * stable-key tail rows that replace in place as the overlay changes. */
export function buildTimelineRows(
  run: RunView,
  overlay: RunLiveOverlay | undefined,
  preview: string | undefined,
): readonly TimelineRow[] {
  return [
    ...run.timeline.map(durableTimelineRow),
    ...liveTimelineRows(run, overlay, preview),
  ];
}

/** Durable rows retain their event vocabulary while giving the interactive
 * categories explicit glyph-and-word labels that survive colour removal. */
function durableTimelineRow(
  event: RunTimelineEvent,
  index: number,
): TimelineRow {
  const detail = event.detail !== undefined ? ` · ${event.detail}` : "";
  const prefix = `${event.at} `;
  // The durable Turn label is driven by the recorded Turn kind (#126), so reopened
  // history distinguishes an Interactive Turn from an Agent Turn by words alone
  // (colour removed). A legacy row with no kind reads a neutral "Turn" — truthful
  // where the kind is genuinely unknown rather than a guess.
  const turnLabel =
    event.turnKind === "interactive-agent"
      ? "Interactive Turn"
      : event.turnKind === "agent"
        ? "Agent Turn"
        : "Turn";
  const label = (() => {
    switch (event.event) {
      case "assistant-content":
        return `◆ Assistant${detail}`;
      case "tool-activity":
        return `↳ Tool activity${detail}`;
      case "turn-started":
        return `● ${turnLabel} started${detail}`;
      case "turn-settled":
        return `● ${turnLabel} settled${detail}`;
      case "request-raised":
        return `? Harness Request raised${detail}`;
      case "request-answered":
        return `? Harness Request answered${detail}`;
      case "request-expired":
        return `? Harness Request expired${detail}`;
      case "checkpoint-blocked":
        return `◆ Human Gate · review checkpoint${detail}`;
      case "gate-answered":
        return `◆ Human Gate answered${detail}`;
      default:
        return `${event.event}${
          event.detail !== undefined ? ` ${event.detail}` : ""
        }`;
    }
  })();
  return {
    key: `durable:${event.at}:${event.event}:${index}`,
    text: prefix + label,
  };
}

function liveTimelineRows(
  run: RunView,
  overlay: RunLiveOverlay | undefined,
  preview: string | undefined,
): readonly TimelineRow[] {
  if (overlay === undefined && preview === undefined) return [];
  const rows: TimelineRow[] = [];
  const stepKind = run.progress[run.position]?.kind;
  const turnLabel =
    stepKind === "interactive-agent" ? "Interactive Turn" : "Agent Turn";
  const phase = overlay?.phase.replace("-", " ") ?? "working";
  rows.push({ key: "live:turn", text: `● ${turnLabel} · ${phase}` });
  if (preview !== undefined) {
    rows.push({
      key: "live:preview",
      text: `✎ Assistant preview · ${oneLine(preview)}`,
    });
  }
  if (overlay?.activity !== undefined) {
    rows.push({
      key: "live:activity",
      text: `↳ Activity · ${oneLine(overlay.activity)}`,
    });
  }
  for (const request of overlay?.outstanding ?? []) {
    rows.push({
      key: `live:request:${request.requestId}`,
      text: `? Harness Request · ${request.tool} · ${oneLine(request.input)}`,
    });
  }
  if (overlay?.context !== undefined) {
    rows.push({
      key: "live:context",
      text: `◫ Context · ${overlay.context.usedTokens} / ${overlay.context.limitTokens} tokens`,
    });
  }
  if (overlay?.usage !== undefined) {
    rows.push({
      key: "live:usage",
      text: `∑ Usage · ${oneLine(overlay.usage)}`,
    });
  }
  return rows;
}

/** Collapse whitespace so a serialized tool input or usage string stays one line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Clip one Workbench content row while preserving an explicit truncation suffix
 * at the right edge. Ordinary rows retain the shared ellipsis behavior. */
export function clipRunContent(text: string, width: number): string {
  const suffix = ` ${RUN_TIMELINE_TRUNCATION_MARKER}`;
  if (!text.endsWith(suffix)) return clip(text, width);
  const suffixWidth = stringWidth(suffix);
  if (width <= suffixWidth) {
    return clip(RUN_TIMELINE_TRUNCATION_MARKER, width);
  }
  const content = text.slice(0, -suffix.length);
  const contentWidth = width - suffixWidth;
  if (stringWidth(content) <= contentWidth) return `${content}${suffix}`;
  const clipped = clip(content, contentWidth);
  return `${clipped.slice(0, -1)}${suffix}`;
}
