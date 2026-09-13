import { TextAttributes } from "@opentui/core";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  Switch,
  Match,
  type Accessor,
} from "solid-js";
import type {
  AnswerHumanGateOffer,
  DiagnosticReference,
  Problem,
  ResourceReference,
  RunCheckpointView,
  RunStepProgress,
  RunStepStatus,
  RunView,
} from "../application/projection-port.js";
import type { RendererPort } from "./renderer/renderer.js";
import { useRunWorkbenchView, type AnswerOutcome } from "./run-view.js";
import {
  AT_LIVE,
  scrollTimeline,
  timelineWindow,
  type TimelineAction,
  type TimelineScroll,
} from "./run-timeline.js";
import { useExit } from "./vendor/exit.js";
import { useTheme } from "./vendor/theme-context.js";

// The Run Workbench (#91): a timeline-first watch of one Run rendering the same
// `run` Projection the headless `run show` prints (headless/render.ts renderRun),
// reached from a successful Start a Run (#90). It is the first production caller
// of the Renderer Port's `size`/`onKey`/`onResize` (A13): a single raw-key
// pipeline drives every control and imperatively scrolls the timeline window,
// while `size`/`onResize` feed the layout breakpoints and the viewport height the
// pure timeline model (run-timeline.ts) windows over. Its one write is the Review
// checkpoint interaction (#92): while the `answer-human-gate` offer is live it
// replaces the bottom footer with two consequence-stating controls that dispatch
// the answer over run-view's `answer` seam; resume/cancel are later slices. The
// Renderer Port stays lifecycle-only elsewhere (see tui/AGENTS.md).
//
// The scroll/follow/anchor/new-activity mechanics are hand-rolled over the event
// array rather than OpenTUI's `<scrollbox>` (which OpenCode's session timeline
// uses at 1ead9e3d7f) because the new-activity count and the append anchor are
// net-new (they don't exist upstream) and need event-index control the
// scrollbox's pixel offset does not give.

const HEADER_COMPACT_WIDTH = 40;
const DETAILS_MIN_WIDTH = 60;
const DETAILS_HEIGHT = 8;
/** Rows the Review checkpoint interaction occupies when it replaces the footer
 *  (#92): facts, the latest verdict, the evidence line, two controls each with
 *  their consequence, and a status/hint line. Fixed so the timeline viewport
 *  shrinks to fit and nothing overflows. */
const CHECKPOINT_HEIGHT = 8;
/** Large content is bounded: at most this many lines are inspected, with an
 *  explicit truncation marker past it (#91 AC4); the bytes are never inlined into
 *  the snapshot, only fetched on open through the reference. */
const MAX_INSPECT_LINES = 500;

const STEP_GLYPH: Record<RunStepStatus, string> = {
  pending: "·",
  running: "…",
  succeeded: "✓",
  failed: "✗",
  blocked: "⏸",
};

type Focus = "timeline" | "details" | "checkpoint";

/** One openable piece of Run evidence, reached through its reference (#91 AC4):
 *  a bound output, the blocked checkpoint's latest Verdict, or the halt
 *  diagnostic. Timeline links exist only where they open real evidence. */
interface Openable {
  readonly label: string;
  readonly reference: ResourceReference | DiagnosticReference;
}

interface Inspection {
  readonly title: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly problem?: Problem;
}

interface KeyLike {
  readonly name?: string;
  readonly ctrl?: boolean;
}

export function RunWorkbench(props: {
  runId: string;
  renderer: RendererPort;
  onLeave: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const view = useRunWorkbenchView();
  const snapshot = view.openRun(props.runId);

  const [dims, setDims] = createSignal(props.renderer.size());
  onCleanup(
    props.renderer.onResize((width, height) => setDims({ width, height })),
  );

  const run = (): RunView | undefined => {
    const result = snapshot().result;
    return result.found ? result.run : undefined;
  };
  const notFound = (): Problem | undefined => {
    const result = snapshot().result;
    return result.found ? undefined : result.problem;
  };
  const events = () => run()?.timeline ?? [];
  const isBlocked = () => run()?.checkpoint !== undefined;

  const answerOffer = createMemo<AnswerHumanGateOffer | undefined>(() =>
    run()?.actionOffers.find(
      (offer): offer is AnswerHumanGateOffer =>
        offer.action === "answer-human-gate",
    ),
  );
  // The interaction is live only while the offer backs it, so no control ever
  // lacks a current Action Offer behind it (#92 AC6).
  const checkpointActive = () =>
    run()?.checkpoint !== undefined && answerOffer() !== undefined;

  const [scroll, setScroll] = createSignal<TimelineScroll>(AT_LIVE);
  const [focus, setFocus] = createSignal<Focus>("timeline");
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [selected, setSelected] = createSignal(0);
  const [inspecting, setInspecting] = createSignal<Inspection | undefined>();
  const [inspectScroll, setInspectScroll] = createSignal<TimelineScroll>({
    mode: "paused",
    top: 0,
  });
  const [control, setControl] = createSignal<"continue" | "stop">("continue");
  const [answerOutcome, setAnswerOutcome] =
    createSignal<Accessor<AnswerOutcome>>();
  const [answerRefusal, setAnswerRefusal] = createSignal<Problem | undefined>();

  // The evidence the details panel offers, in a stable order: bound outputs,
  // then a blocked checkpoint's latest Verdict, then a halt diagnostic.
  const openables = createMemo<readonly Openable[]>(() => {
    const current = run();
    if (current === undefined) return [];
    const list: Openable[] = current.outputs.map((output) => ({
      label: `${output.name} (${output.type})`,
      reference: output.reference,
    }));
    if (current.checkpoint !== undefined) {
      const verdict = current.checkpoint.latestVerdict;
      list.push({
        label: `checkpoint verdict: ${verdict.name} = ${verdict.value}`,
        reference: verdict.reference,
      });
    }
    if (current.conflict !== undefined) {
      list.push({
        label: `halt diagnostic: ${current.conflict.artifactName}`,
        reference: current.conflict.reference,
      });
    }
    return list;
  });

  // The checkpoint interaction's evidence line: the bound outputs (the latest
  // output and any candidate changes). The latest Verdict has its own line, so it
  // is not repeated here (the openables list above still offers it in Details).
  const evidenceLabels = createMemo<readonly string[]>(() =>
    (run()?.outputs ?? []).map((output) => `${output.name} (${output.type})`),
  );

  const interiorH = () => Math.max(1, dims().height - 2);
  const innerW = () => Math.max(1, dims().width - 2);
  const compactHeader = () => dims().width < HEADER_COMPACT_WIDTH;
  const chrome = () =>
    (compactHeader() ? 1 : 2) +
    (isBlocked() ? 1 : 0) +
    1 /*progress*/ +
    1 /*timeline label*/ +
    (checkpointActive()
      ? CHECKPOINT_HEIGHT
      : 1); /*footer, or the checkpoint interaction that replaces it*/
  // The details panel needs both room across (its width breakpoint) and room
  // down: DETAILS_HEIGHT rows plus at least one timeline row. On a short terminal
  // it stays hidden rather than clipping the panel and footer off the bottom.
  const detailsAvailable = () =>
    dims().width >= DETAILS_MIN_WIDTH &&
    interiorH() - chrome() - DETAILS_HEIGHT >= 1;
  const detailsShown = () => detailsOpen() && detailsAvailable();
  const viewportH = () =>
    Math.max(1, interiorH() - chrome() - (detailsShown() ? DETAILS_HEIGHT : 0));
  // The selection can point past the end after a durable update drops outputs; a
  // clamped read keeps the highlight and any open on a real row.
  const selectedRef = () =>
    Math.min(selected(), Math.max(0, openables().length - 1));

  // If the panel becomes unavailable (a resize below either breakpoint) while it
  // held focus, hand focus back to the timeline so the footer and marker stay
  // honest about what the keys do.
  createEffect(() => {
    if (!detailsShown() && focus() === "details") setFocus("timeline");
  });

  const answerPending = () => {
    const accessor = answerOutcome();
    return accessor !== undefined && accessor().kind === "pending";
  };

  const dispatchAnswer = (answer: "continue" | "stop") => {
    if (answerPending()) return;
    const checkpoint = run()?.checkpoint;
    if (checkpoint === undefined) return;
    setAnswerRefusal(undefined);
    // Set the accessor before the settlement effect reads it: the live seam
    // settles inline, so storing it fires the effect at once (mirrors start-run's
    // pending-first ordering, which keeps a synchronous seam from wedging).
    setAnswerOutcome(() => view.answer(checkpoint.gate, answer));
  };

  // Follow the answer to its settlement. A refusal (a stale Gate, or a Run no
  // longer blocked) surfaces in the interaction and re-enables the controls; an
  // applied answer just clears local state — the live snapshot drops the
  // checkpoint and its offer, so the interaction disappears on its own.
  createEffect(() => {
    const accessor = answerOutcome();
    if (accessor === undefined) return;
    const settled = accessor();
    if (settled.kind === "pending") return;
    if (settled.kind === "refused") setAnswerRefusal(settled.problem);
    setAnswerOutcome(undefined);
  });

  // Focus lands on the interaction as each new checkpoint appears and returns to
  // the timeline when it leaves (#92 AC5), without yanking focus back while the
  // user has tabbed away during a still-blocked Run. Keyed on the Gate's Attempt,
  // so a re-block at a *fresh* Gate also resets the control to the safer Continue
  // and clears any refusal left from answering the previous Gate.
  let lastGateKey = "";
  createEffect(() => {
    const gate = run()?.checkpoint?.gate;
    const active = checkpointActive();
    const key = gate !== undefined ? `${gate.stepId}:${gate.attemptId}` : "";
    if (active && key !== lastGateKey) {
      setFocus("checkpoint");
      setControl("continue");
      setAnswerRefusal(undefined);
    } else if (!active && focus() === "checkpoint") {
      setFocus("timeline");
    }
    lastGateKey = active ? key : "";
  });

  // Tab cycles the focusable regions in a stable order: the checkpoint (while its
  // offer is live), the timeline, then the details panel (while shown).
  const focusOrder = (): Focus[] => {
    const order: Focus[] = [];
    if (checkpointActive()) order.push("checkpoint");
    order.push("timeline");
    if (detailsShown()) order.push("details");
    return order;
  };
  const cycleFocus = () => {
    const order = focusOrder();
    const index = order.indexOf(focus());
    setFocus(order[(index + 1) % order.length] ?? "timeline");
  };

  const win = () => timelineWindow(scroll(), events().length, viewportH());
  const visibleEvents = () => {
    const w = win();
    return events().slice(w.top, w.top + w.visible);
  };

  const scrollBy = (action: TimelineAction) =>
    setScroll((prev) =>
      scrollTimeline(prev, action, events().length, viewportH()),
    );

  const moveSelection = (delta: number) => {
    const count = openables().length;
    if (count === 0) return;
    setSelected((index) => Math.max(0, Math.min(index + delta, count - 1)));
  };

  const openSelected = () => {
    const target = openables()[selectedRef()];
    if (target === undefined) return;
    const read = view.readResource(target.reference);
    if (!read.found) {
      setInspecting({
        title: target.label,
        lines: [],
        truncated: false,
        problem: read.problem,
      });
    } else {
      const all = read.content.split("\n");
      const truncated = all.length > MAX_INSPECT_LINES;
      setInspecting({
        title: target.label,
        lines: truncated ? all.slice(0, MAX_INSPECT_LINES) : all,
        truncated,
      });
    }
    setInspectScroll({ mode: "paused", top: 0 });
  };

  // Display lines include an explicit truncation marker as the final row when the
  // resource was capped, so it scrolls into view like any other line (#91 AC4).
  const inspectLines = (): readonly string[] => {
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
  const inspectViewportH = () => Math.max(1, interiorH() - 2); // title + footer
  const inspectWin = () =>
    timelineWindow(inspectScroll(), inspectLines().length, inspectViewportH());

  const KEY_ACTIONS: Record<string, TimelineAction> = {
    up: "up",
    down: "down",
    pageup: "pageUp",
    pagedown: "pageDown",
    home: "top",
    end: "latest",
    g: "top",
  };

  const handleKey = (raw: unknown) => {
    const key = raw as KeyLike;
    const name = key.name ?? "";
    if (name === "q" || (name === "c" && key.ctrl)) {
      exit();
      return;
    }
    // Inspection overlay: scroll it, Escape closes and restores the panel focus.
    if (inspecting() !== undefined) {
      if (name === "escape") {
        setInspecting(undefined);
        return;
      }
      const action = KEY_ACTIONS[name];
      if (action !== undefined)
        setInspectScroll((prev) =>
          scrollTimeline(
            prev,
            action,
            inspectLines().length,
            inspectViewportH(),
          ),
        );
      return;
    }
    if (run() === undefined) {
      if (name === "escape") props.onLeave();
      return;
    }
    // Review checkpoint interaction (#92): the two controls replace the footer
    // while the offer is live. Left/right choose, enter dispatches; both are
    // unavailable while the answer is pending.
    if (focus() === "checkpoint" && checkpointActive()) {
      switch (name) {
        case "left":
          if (!answerPending()) setControl("continue");
          return;
        case "right":
          if (!answerPending()) setControl("stop");
          return;
        case "return":
          dispatchAnswer(control());
          return;
        case "tab":
          cycleFocus();
          return;
        case "d":
          if (detailsAvailable()) {
            setDetailsOpen(true);
            setSelected(0);
            setFocus("details");
          }
          return;
        case "escape":
          props.onLeave();
          return;
        default:
          return;
      }
    }
    if (focus() === "details" && detailsShown()) {
      switch (name) {
        case "up":
          moveSelection(-1);
          return;
        case "down":
          moveSelection(1);
          return;
        case "return":
        case "o":
          openSelected();
          return;
        case "tab":
          cycleFocus();
          return;
        case "d":
          setDetailsOpen(false);
          setFocus("timeline");
          return;
        case "escape":
          setFocus("timeline");
          return;
        default:
          return;
      }
    }
    // Timeline focus.
    switch (name) {
      case "d":
        if (!detailsAvailable()) return; // hidden below a width/height breakpoint
        setDetailsOpen(true);
        setSelected(0);
        setFocus("details");
        return;
      case "tab":
        cycleFocus();
        return;
      case "escape":
        props.onLeave();
        return;
      default: {
        const action = KEY_ACTIONS[name];
        if (action !== undefined) scrollBy(action);
      }
    }
  };
  onCleanup(props.renderer.onKey(handleKey));

  return (
    <box
      width={dims().width}
      height={dims().height}
      flexDirection="column"
      padding={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <Switch>
        <Match when={inspecting()}>
          {(current) => (
            <InspectionView
              inspection={current()}
              lines={inspectLines}
              window={inspectWin}
              width={innerW}
              theme={theme}
            />
          )}
        </Match>
        <Match when={notFound()}>
          {(problem) => (
            <NotFoundView
              runId={props.runId}
              problem={problem()}
              width={innerW}
              theme={theme}
            />
          )}
        </Match>
        <Match when={run()}>
          {(current) => (
            <Workbench
              run={current}
              compactHeader={compactHeader}
              detailsShown={detailsShown}
              detailsHeight={DETAILS_HEIGHT}
              viewportH={viewportH}
              innerW={innerW}
              win={win}
              visibleEvents={visibleEvents}
              focus={focus}
              openables={openables}
              selected={selectedRef}
              checkpointActive={checkpointActive}
              offer={answerOffer}
              evidence={evidenceLabels}
              control={control}
              answerPending={answerPending}
              answerRefusal={answerRefusal}
              theme={theme}
            />
          )}
        </Match>
      </Switch>
    </box>
  );
}

type Theme = ReturnType<typeof useTheme>["theme"];

function clip(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

function stateColor(theme: Theme, state: string) {
  switch (state) {
    case "succeeded":
      return theme.success;
    case "failed":
      return theme.error;
    case "blocked":
    case "halted":
      return theme.warning;
    case "running":
      return theme.accent;
    default:
      return theme.textMuted;
  }
}

function positionText(run: RunView): string {
  return run.position >= run.progress.length
    ? "at rest"
    : `step ${run.position + 1} of ${run.progress.length}`;
}

function Workbench(props: {
  run: Accessor<RunView>;
  compactHeader: Accessor<boolean>;
  detailsShown: Accessor<boolean>;
  detailsHeight: number;
  viewportH: Accessor<number>;
  innerW: Accessor<number>;
  win: Accessor<ReturnType<typeof timelineWindow>>;
  visibleEvents: Accessor<RunView["timeline"]>;
  focus: Accessor<Focus>;
  openables: Accessor<readonly Openable[]>;
  selected: Accessor<number>;
  checkpointActive: Accessor<boolean>;
  offer: Accessor<AnswerHumanGateOffer | undefined>;
  evidence: Accessor<readonly string[]>;
  control: Accessor<"continue" | "stop">;
  answerPending: Accessor<boolean>;
  answerRefusal: Accessor<Problem | undefined>;
  theme: Theme;
}) {
  const { theme } = props;
  const run = props.run;
  const w = () => props.innerW();

  const timelineLabel = () => {
    const marker = props.focus() === "timeline" ? "› " : "  ";
    const activity = props.win();
    const badge =
      !activity.atLive && activity.newActivity > 0
        ? `  ▼ ${activity.newActivity} new · end to jump`
        : activity.atLive
          ? "  (live)"
          : "";
    return `${marker}Timeline${badge}`;
  };

  const footer = () =>
    props.focus() === "details"
      ? "↑/↓ select · enter open · tab timeline · esc back · q quit"
      : "↑/↓ scroll · d details · end latest · esc back · q quit";

  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* Compact header: Bundle name, Run id, state in words as well as colour. */}
      <box flexDirection="column" flexShrink={0}>
        <Show
          when={!props.compactHeader()}
          fallback={
            <text fg={stateColor(theme, run().state)}>
              {clip(`Run ${run().runId} — ${run().state.toUpperCase()}`, w())}
            </text>
          }
        >
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {clip(`${run().bundle.name} — ${run().state.toUpperCase()}`, w())}
          </text>
          <text fg={theme.textMuted}>
            {clip(`Run ${run().runId} · ${positionText(run())}`, w())}
          </text>
        </Show>
      </box>

      {/* A blocked Run rests at a Review checkpoint: say so plainly (#91 AC "waiting for review"). */}
      <Show when={run().checkpoint}>
        {(checkpoint) => (
          <text fg={theme.warning} flexShrink={0}>
            {clip(`⏸ waiting for review — ${checkpoint().message}`, w())}
          </text>
        )}
      </Show>

      {/* Always-visible Workflow progress, readable without colour via glyphs. */}
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(progressLine(run().progress), w())}
      </text>

      <text
        fg={props.focus() === "timeline" ? theme.text : theme.textMuted}
        attributes={props.focus() === "timeline" ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(timelineLabel(), w())}
      </text>

      {/* The timeline viewport: exactly `viewportH` single-line rows, windowed by
          the pure model. ponytail: one line per event — M2 timeline events are
          single-line facts; variable-height rows arrive when an event grows a
          body worth wrapping. */}
      <box
        flexDirection="column"
        height={props.viewportH()}
        flexShrink={0}
        overflow="hidden"
      >
        <Show
          when={run().timeline.length > 0}
          fallback={
            <text fg={theme.textMuted} flexShrink={0}>
              {"  (no activity yet)"}
            </text>
          }
        >
          <For each={props.visibleEvents()}>
            {(event) => (
              <text fg={theme.text} flexShrink={0}>
                {clip(
                  `  ${event.at} ${event.event}${
                    event.detail !== undefined ? ` ${event.detail}` : ""
                  }`,
                  w(),
                )}
              </text>
            )}
          </For>
        </Show>
      </box>

      <Show when={props.detailsShown()}>
        <DetailsPanel
          run={run}
          height={props.detailsHeight}
          width={props.innerW}
          focused={() => props.focus() === "details"}
          openables={props.openables}
          selected={props.selected}
          theme={theme}
        />
      </Show>

      {/* While the answer-human-gate offer is live the interaction replaces the
          footer input rather than sharing a permanent rail (#92). */}
      <Show
        when={props.checkpointActive() ? run().checkpoint : undefined}
        fallback={
          <text fg={theme.textMuted} flexShrink={0}>
            {clip(footer(), w())}
          </text>
        }
      >
        {(checkpoint) => (
          <CheckpointInteraction
            checkpoint={checkpoint}
            offer={props.offer}
            evidence={props.evidence}
            control={props.control}
            focused={() => props.focus() === "checkpoint"}
            pending={props.answerPending}
            refusal={props.answerRefusal}
            width={props.innerW}
            theme={theme}
          />
        )}
      </Show>
    </box>
  );
}

/** The Review checkpoint interaction (#92): the authored message and cadence, the
 *  completed-iteration count, the latest `fail` Verdict, the openable evidence,
 *  and two consequence-stating controls. It replaces the footer while blocked;
 *  every line is plain text so both consequences read with colour removed. */
function CheckpointInteraction(props: {
  checkpoint: Accessor<RunCheckpointView>;
  offer: Accessor<AnswerHumanGateOffer | undefined>;
  evidence: Accessor<readonly string[]>;
  control: Accessor<"continue" | "stop">;
  focused: Accessor<boolean>;
  pending: Accessor<boolean>;
  refusal: Accessor<Problem | undefined>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const cp = () => props.checkpoint();
  const continueLabel = () => `Continue ${cp().interval} More Iterations`;
  const marker = (which: "continue" | "stop") =>
    props.focused() && props.control() === which ? "› " : "  ";
  const evidence = () => {
    const labels = props.evidence();
    return labels.length > 0 ? labels.join(" · ") : "(none)";
  };
  const status = () => {
    if (props.pending()) return "… submitting your answer";
    const refusal = props.refusal();
    if (refusal !== undefined)
      return `refused: ${refusal.explanation} ${refusal.remediation}`;
    return "←/→ choose · enter confirm · tab timeline · esc back · q quit";
  };
  return (
    <box
      flexDirection="column"
      height={CHECKPOINT_HEIGHT}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <text
        fg={props.focused() ? theme.warning : theme.textMuted}
        attributes={props.focused() ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(
          `${props.focused() ? "› " : "  "}Review checkpoint · every ${cp().interval} iteration(s) · ${cp().completedIterations} completed`,
          w(),
        )}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(
          `  latest: ${cp().latestVerdict.name} = ${cp().latestVerdict.value} · evidence: ${evidence()}`,
          w(),
        )}
      </text>
      <text
        fg={theme.text}
        attributes={props.control() === "continue" ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(
          `${marker("continue")}[ ${continueLabel()} ]${props.pending() ? "  (unavailable)" : ""}`,
          w(),
        )}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`    ${props.offer()?.continueConsequence ?? ""}`, w())}
      </text>
      <text
        fg={theme.text}
        attributes={props.control() === "stop" ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(
          `${marker("stop")}[ Stop Run ]${props.pending() ? "  (unavailable)" : ""}`,
          w(),
        )}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`    ${props.offer()?.stopConsequence ?? ""}`, w())}
      </text>
      <text
        fg={props.refusal() !== undefined ? theme.error : theme.textMuted}
        flexShrink={0}
      >
        {clip(status(), w())}
      </text>
    </box>
  );
}

function progressLine(progress: readonly RunStepProgress[]): string {
  if (progress.length === 0) return "Progress: (no steps)";
  const parts = progress.map((step) => `${STEP_GLYPH[step.status]} ${step.id}`);
  return `Progress: ${parts.join(" · ")}`;
}

function DetailsPanel(props: {
  run: Accessor<RunView>;
  height: number;
  width: Accessor<number>;
  focused: Accessor<boolean>;
  openables: Accessor<readonly Openable[]>;
  selected: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const run = props.run;
  const w = () => props.width();
  return (
    <box
      flexDirection="column"
      height={props.height}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <text
        fg={props.focused() ? theme.text : theme.textMuted}
        attributes={props.focused() ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(`${props.focused() ? "› " : "  "}Details`, w())}
      </text>
      <text fg={theme.text} flexShrink={0}>
        {clip(
          `  ${run().bundle.id}@${run().bundle.version} · sha256:${run().bundle.digest}`,
          w(),
        )}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`  Workspace: ${run().workspacePath}`, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`  Launched: ${run().launchedAt} · ${positionText(run())}`, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip("  Resources:", w())}
      </text>
      <Show
        when={props.openables().length > 0}
        fallback={
          <text fg={theme.textMuted} flexShrink={0}>
            {clip("    (none)", w())}
          </text>
        }
      >
        <For each={props.openables()}>
          {(openable, index) => (
            <text
              fg={theme.text}
              attributes={
                props.focused() && index() === props.selected()
                  ? TextAttributes.BOLD
                  : 0
              }
              flexShrink={0}
            >
              {clip(
                `    ${props.focused() && index() === props.selected() ? "› " : "  "}${openable.label}`,
                w(),
              )}
            </text>
          )}
        </For>
      </Show>
    </box>
  );
}

function InspectionView(props: {
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

function NotFoundView(props: {
  runId: string;
  problem: Problem;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <text fg={theme.error} attributes={TextAttributes.BOLD} flexShrink={0}>
        {clip(`Run ${props.runId} not found`, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(props.problem.explanation, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(props.problem.remediation, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        esc back · q quit
      </text>
    </box>
  );
}
