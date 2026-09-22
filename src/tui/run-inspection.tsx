import { TextAttributes } from "@opentui/core";
import { createSignal, For, type Accessor } from "solid-js";
import stripAnsi from "strip-ansi";
import type {
  DiagnosticReference,
  Problem,
  ResourceRead,
  ResourceReference,
  RunTranscriptEntryView,
  TranscriptPageReference,
  TranscriptRead,
} from "../application/projection-port.js";
import { RUN_TIMELINE_TRUNCATION_MARKER } from "../application/projection-port.js";
import { clip } from "./clip.js";
import {
  AT_LIVE,
  SCROLL_KEYS,
  scrollTimeline,
  timelineWindow,
  type TimelineScroll,
} from "./run-timeline.js";
import { clipRunContent } from "./run-timeline-rows.js";
import { useTheme } from "./vendor/theme-context.js";

// The Run Workbench's reference-inspection overlay, split out of run-workbench.tsx
// (A26): its state, its self-contained modal key branch, and its view interleave
// with nothing else in the Workbench, so they live here as one controller plus the
// `InspectionView` component. The Workbench selects which evidence to open (from
// its Details panel) and hands it here; everything about *showing* the bytes —
// stripping escapes, bounding the line count, scrolling, closing — is owned here.
//
// A Session transcript (#124) is a special evidence kind: it opens the newest
// bounded page through a `page` Resource Reference, and pages older upward on
// demand — never materializing the whole export to inspect a page. Scrolling up at
// the top loads the next older page and preserves the first visible entry by
// bumping the pinned top by the number of lines prepended.

type Theme = ReturnType<typeof useTheme>["theme"];

/** One openable piece of Run evidence, reached through its reference (#91 AC4):
 *  a bound output, the blocked checkpoint's latest Verdict, the halt diagnostic,
 *  or a paged Session transcript (#124). Timeline links exist only where they
 *  open real evidence. Exactly one source is set (the union makes that explicit
 *  at the Workbench seam). */
export type Openable =
  | {
      readonly label: string;
      readonly reference: ResourceReference | DiagnosticReference;
      readonly content?: never;
      readonly transcript?: never;
    }
  | {
      readonly label: string;
      readonly content: string;
      readonly reference?: never;
      readonly transcript?: never;
    }
  | {
      readonly label: string;
      readonly transcript: TranscriptPageReference;
      readonly reference?: never;
      readonly content?: never;
    };

interface BlobInspection {
  readonly kind: "blob";
  readonly title: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly problem?: Problem;
}

interface TranscriptInspection {
  readonly kind: "transcript";
  readonly title: string;
  readonly pageRef: TranscriptPageReference;
  readonly entries: readonly RunTranscriptEntryView[];
  /** The opaque cursor for the next older page, absent once the oldest is loaded. */
  readonly older?: string;
  readonly problem?: Problem;
  /** A failed older-page read is visible without discarding the retry cursor or
   * the transcript entries already on screen. */
  readonly olderProblem?: Problem;
}

type Inspection = BlobInspection | TranscriptInspection;

type TTranscriptInspectionParams = {
  readonly title: string;
  readonly pageRef: TranscriptPageReference;
  readonly entries: readonly RunTranscriptEntryView[];
  readonly older?: string;
  readonly olderProblem?: Problem;
};

function transcriptInspection(
  params: TTranscriptInspectionParams,
): TranscriptInspection {
  if (params.older !== undefined && params.olderProblem !== undefined) {
    return {
      kind: "transcript",
      title: params.title,
      pageRef: params.pageRef,
      entries: params.entries,
      older: params.older,
      olderProblem: params.olderProblem,
    };
  }
  if (params.older !== undefined) {
    return {
      kind: "transcript",
      title: params.title,
      pageRef: params.pageRef,
      entries: params.entries,
      older: params.older,
    };
  }
  if (params.olderProblem !== undefined) {
    return {
      kind: "transcript",
      title: params.title,
      pageRef: params.pageRef,
      entries: params.entries,
      olderProblem: params.olderProblem,
    };
  }
  return {
    kind: "transcript",
    title: params.title,
    pageRef: params.pageRef,
    entries: params.entries,
  };
}

/** Large blob content is bounded: at most this many lines are inspected, with an
 *  explicit truncation marker past it (#91 AC4). A transcript is bounded instead
 *  by paging, so it has no such cap. */
const MAX_INSPECT_LINES = 500;

export interface InspectionController {
  /** The open inspection, or undefined when the overlay is closed. */
  readonly inspecting: Accessor<Inspection | undefined>;
  /** Open one Openable: resolve its reference (or newest transcript page), strip
   *  escapes, bound the lines. */
  open(target: Openable): void;
  /** Handle a key while the overlay is open. Returns true if it consumed the
   *  key (the overlay is open), so the Workbench stops dispatching it further. */
  handleKey(name: string): boolean;
  /** The display lines, including a truncation marker or a Problem's text. */
  readonly lines: Accessor<readonly string[]>;
  /** The scrolled window over `lines`. */
  readonly window: Accessor<ReturnType<typeof timelineWindow>>;
}

/** The Workbench's inspection overlay controller. `readResource` resolves an
 *  output/diagnostic reference to its bytes; `readTranscript` resolves a bounded
 *  transcript page; `interiorH` is the Workbench's interior height, which the
 *  overlay windows its content over (title + footer subtracted). */
export function createInspection(deps: {
  readResource: (
    reference: ResourceReference | DiagnosticReference,
  ) => ResourceRead;
  readTranscript: (reference: TranscriptPageReference) => TranscriptRead;
  interiorH: Accessor<number>;
}): InspectionController {
  const [inspecting, setInspecting] = createSignal<Inspection | undefined>();
  const [scroll, setScroll] = createSignal<TimelineScroll>({
    mode: "paused",
    top: 0,
  });

  const open = (target: Openable): void => {
    if (target.transcript !== undefined) {
      openTranscript(target.label, target.transcript);
      return;
    }
    const read =
      target.content !== undefined
        ? ({ found: true, type: "text", content: target.content } as const)
        : deps.readResource(target.reference);
    if (!read.found) {
      setInspecting({
        kind: "blob",
        title: target.label,
        lines: [],
        truncated: false,
        problem: read.problem,
      });
    } else {
      // Captured output can carry colour escapes and bare carriage returns from a
      // command forcing colour or drawing a progress bar (D4): strip the escapes
      // and split on `\r?\n` so a `\r` never corrupts a rendered row.
      const all = stripAnsi(read.content).split(/\r?\n/);
      const truncated = all.length > MAX_INSPECT_LINES;
      setInspecting({
        kind: "blob",
        title: target.label,
        lines: truncated ? all.slice(0, MAX_INSPECT_LINES) : all,
        truncated,
      });
    }
    setScroll({ mode: "paused", top: 0 });
  };

  const openTranscript = (
    label: string,
    pageRef: TranscriptPageReference,
  ): void => {
    const read = deps.readTranscript(pageRef);
    if (!read.found) {
      setInspecting({
        kind: "transcript",
        title: label,
        pageRef,
        entries: [],
        problem: read.problem,
      });
      setScroll({ mode: "paused", top: 0 });
      return;
    }
    setInspecting({
      kind: "transcript",
      title: label,
      pageRef,
      entries: read.entries,
      ...(read.type === "transcript-page" && read.older !== undefined
        ? { older: read.older }
        : {}),
    });
    // Open on the newest page's newest entries (the live edge, the bottom).
    setScroll(AT_LIVE);
  };

  // Load the next older page and prepend it, preserving the first visible entry:
  // every existing line shifts down by the number of lines prepended, so the
  // pinned top is bumped by the same amount (#124 AC3).
  const loadOlder = (): void => {
    const current = inspecting();
    if (
      current === undefined ||
      current.kind !== "transcript" ||
      current.older === undefined
    ) {
      return;
    }
    const read = deps.readTranscript({
      ...current.pageRef,
      older: current.older,
    });
    if (!read.found) {
      // A failed read (e.g. a raced owner reacquire) leaves the cursor in place so
      // a later scroll-up retries. Keep the current entries and surface the Problem
      // above them instead of silently pretending the oldest was reached.
      setInspecting(
        transcriptInspection({
          title: current.title,
          pageRef: current.pageRef,
          entries: current.entries,
          older: current.older,
          olderProblem: read.problem,
        }),
      );
      return;
    }
    if (read.type !== "transcript-page") {
      return;
    }
    // transcriptLines is a per-entry concatenation, so the prepended line count is
    // exactly the older page's lines — no need to re-render the whole transcript.
    const oldTop = window().top;
    const prepended = transcriptLines(read.entries).length;
    setInspecting(
      transcriptInspection({
        title: current.title,
        pageRef: current.pageRef,
        entries: read.entries.concat(current.entries),
        older: read.older,
      }),
    );
    setScroll({ mode: "paused", top: oldTop + prepended });
  };

  // Display lines include an explicit truncation marker as the final row when a
  // blob was capped, so it scrolls into view like any other line (#91 AC4).
  const lines = (): readonly string[] => {
    const current = inspecting();
    if (current === undefined) return [];
    if (current.problem !== undefined) {
      return [
        `Error [${current.problem.code}]: ${current.problem.explanation}`,
        current.problem.remediation,
      ];
    }
    if (current.kind === "transcript") {
      const content = transcriptLines(current.entries);
      if (current.olderProblem === undefined) return content;
      return [
        `Notice [${current.olderProblem.code}]: ${current.olderProblem.explanation}`,
        current.olderProblem.remediation,
      ].concat(content);
    }
    if (!current.truncated) return current.lines;
    const last = current.lines.at(-1);
    if (last === undefined) return [RUN_TIMELINE_TRUNCATION_MARKER];
    return current.lines
      .slice(0, -1)
      .concat(`${last} ${RUN_TIMELINE_TRUNCATION_MARKER}`);
  };
  const viewportH = () => Math.max(1, deps.interiorH() - 2); // title + footer
  const window = () => timelineWindow(scroll(), lines().length, viewportH());

  const handleKey = (name: string): boolean => {
    const current = inspecting();
    if (current === undefined) return false;
    if (name === "escape") {
      setInspecting(undefined);
      return true;
    }
    const action = SCROLL_KEYS[name];
    if (action === undefined) return true;
    // At the top of a transcript with older history, page older before scrolling,
    // so the upward step reveals the just-loaded older entries.
    if (
      current.kind === "transcript" &&
      current.older !== undefined &&
      (action === "up" || action === "pageUp" || action === "top") &&
      window().top === 0
    ) {
      loadOlder();
    }
    setScroll((prev) =>
      scrollTimeline(prev, action, lines().length, viewportH()),
    );
    return true;
  };

  return { inspecting, open, handleKey, lines, window };
}

/** Render transcript entries as display lines: a role header per entry, then its
 *  content split on `\r?\n` with escapes stripped (captured content can carry
 *  colour), then a blank separator. Whole-entry blocks, so a prepend adds only
 *  leading lines and the anchor bump is exact. */
function transcriptLines(
  entries: readonly RunTranscriptEntryView[],
): readonly string[] {
  const out: string[] = [];
  for (const entry of entries) {
    out.push(
      entry.role === "user"
        ? `◇ User Turn · session ${entry.session}`
        : `◆ Assistant · session ${entry.session}`,
    );
    for (const line of stripAnsi(entry.content).split(/\r?\n/)) out.push(line);
    out.push("");
  }
  return out;
}

export function InspectionView(props: {
  inspection: Inspection;
  lines: Accessor<readonly string[]>;
  window: Accessor<ReturnType<typeof timelineWindow>>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const visible = () => {
    const win = props.window();
    return props.lines().slice(win.top, win.top + win.visible);
  };
  const footer = () =>
    props.inspection.kind === "transcript"
      ? "↑/↓ scroll · ↑ at top loads older · esc close · q quit"
      : "↑/↓ scroll · esc close · q quit";
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <text fg={theme.text} attributes={TextAttributes.BOLD} flexShrink={0}>
        {clip(props.inspection.title, w())}
      </text>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <For each={visible()}>
          {(line) => (
            <text fg={theme.text} flexShrink={0}>
              {clipRunContent(line, w())}
            </text>
          )}
        </For>
      </box>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(footer(), w())}
      </text>
    </box>
  );
}
