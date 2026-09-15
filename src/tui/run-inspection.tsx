import { TextAttributes } from "@opentui/core";
import { createSignal, For, type Accessor } from "solid-js";
import stripAnsi from "strip-ansi";
import type {
  DiagnosticReference,
  Problem,
  ResourceRead,
  ResourceReference,
} from "../application/projection-port.js";
import { clip } from "./clip.js";
import {
  SCROLL_KEYS,
  scrollTimeline,
  timelineWindow,
  type TimelineScroll,
} from "./run-timeline.js";
import { useTheme } from "./vendor/theme-context.js";

// The Run Workbench's reference-inspection overlay, split out of run-workbench.tsx
// (A26): its state, its self-contained modal key branch, and its view interleave
// with nothing else in the Workbench, so they live here as one controller plus the
// `InspectionView` component. The Workbench selects which evidence to open (from
// its Details panel) and hands it here; everything about *showing* the bytes —
// stripping escapes, bounding the line count, scrolling, closing — is owned here.

type Theme = ReturnType<typeof useTheme>["theme"];

/** One openable piece of Run evidence, reached through its reference (#91 AC4):
 *  a bound output, the blocked checkpoint's latest Verdict, or the halt
 *  diagnostic. Timeline links exist only where they open real evidence. */
export interface Openable {
  readonly label: string;
  readonly reference: ResourceReference | DiagnosticReference;
}

interface Inspection {
  readonly title: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly problem?: Problem;
}

/** Large content is bounded: at most this many lines are inspected, with an
 *  explicit truncation marker past it (#91 AC4); the bytes are never inlined into
 *  the snapshot, only fetched on open through the reference. */
const MAX_INSPECT_LINES = 500;

export interface InspectionController {
  /** The open inspection, or undefined when the overlay is closed. */
  readonly inspecting: Accessor<Inspection | undefined>;
  /** Open one Openable: resolve its reference, strip escapes, bound the lines. */
  open(target: Openable): void;
  /** Handle a key while the overlay is open. Returns true if it consumed the
   *  key (the overlay is open), so the Workbench stops dispatching it further. */
  handleKey(name: string): boolean;
  /** The display lines, including a truncation marker or a Problem's text. */
  readonly lines: Accessor<readonly string[]>;
  /** The scrolled window over `lines`. */
  readonly window: Accessor<ReturnType<typeof timelineWindow>>;
}

/** The Workbench's inspection overlay controller. `readResource` resolves a
 *  reference to its bytes; `interiorH` is the Workbench's interior height, which
 *  the overlay windows its content over (title + footer subtracted). */
export function createInspection(deps: {
  readResource: (
    reference: ResourceReference | DiagnosticReference,
  ) => ResourceRead;
  interiorH: Accessor<number>;
}): InspectionController {
  const [inspecting, setInspecting] = createSignal<Inspection | undefined>();
  const [scroll, setScroll] = createSignal<TimelineScroll>({
    mode: "paused",
    top: 0,
  });

  const open = (target: Openable): void => {
    const read = deps.readResource(target.reference);
    if (!read.found) {
      setInspecting({
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
        title: target.label,
        lines: truncated ? all.slice(0, MAX_INSPECT_LINES) : all,
        truncated,
      });
    }
    setScroll({ mode: "paused", top: 0 });
  };

  // Display lines include an explicit truncation marker as the final row when the
  // resource was capped, so it scrolls into view like any other line (#91 AC4).
  const lines = (): readonly string[] => {
    const current = inspecting();
    if (current === undefined) return [];
    if (current.problem !== undefined) {
      return [
        `Error [${current.problem.code}]: ${current.problem.explanation}`,
        current.problem.remediation,
      ];
    }
    return current.truncated
      ? [
          ...current.lines,
          `… output truncated (first ${MAX_INSPECT_LINES} lines)`,
        ]
      : current.lines;
  };
  const viewportH = () => Math.max(1, deps.interiorH() - 2); // title + footer
  const window = () => timelineWindow(scroll(), lines().length, viewportH());

  const handleKey = (name: string): boolean => {
    if (inspecting() === undefined) return false;
    if (name === "escape") {
      setInspecting(undefined);
      return true;
    }
    const action = SCROLL_KEYS[name];
    if (action !== undefined)
      setScroll((prev) =>
        scrollTimeline(prev, action, lines().length, viewportH()),
      );
    return true;
  };

  return { inspecting, open, handleKey, lines, window };
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
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <text fg={theme.text} attributes={TextAttributes.BOLD} flexShrink={0}>
        {clip(props.inspection.title, w())}
      </text>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <For each={visible()}>
          {(line) => (
            <text fg={theme.text} flexShrink={0}>
              {clip(line, w())}
            </text>
          )}
        </For>
      </box>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip("↑/↓ scroll · esc close · q quit", w())}
      </text>
    </box>
  );
}
