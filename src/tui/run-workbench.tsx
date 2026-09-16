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
  CancelRunOffer,
  DeleteRunOffer,
  Problem,
  ResumeRunOffer,
  RunCheckpointView,
  RunStateName,
  RunStepProgress,
  RunStepStatus,
  RunView,
} from "../application/projection-port.js";
import type { RendererKeyEvent, RendererPort } from "./renderer/renderer.js";
import { clip } from "./clip.js";
import {
  useRunActionsView,
  type RunActionOutcome,
} from "./run-actions-view.js";
import { useRunWorkbenchView, type AnswerOutcome } from "./run-view.js";
import {
  createInspection,
  InspectionView,
  type Openable,
} from "./run-inspection.js";
import {
  AT_LIVE,
  SCROLL_KEYS,
  scrollTimeline,
  timelineWindow,
  type TimelineAction,
  type TimelineScroll,
} from "./run-timeline.js";
import { buildTimelineRows, type TimelineRow } from "./run-timeline-rows.js";
import { useExit } from "./vendor/exit.js";
import { useDialog } from "./vendor/dialog.js";
import { useTheme } from "./vendor/theme-context.js";

// The Run Workbench (#91): a timeline-first watch of one Run rendering the same
// `run` Projection the headless `run show` prints (headless/render.ts renderRun),
// reached from a successful Start a Run (#90). It is the first production caller
// of the Renderer Port's `size`/`onKey`/`onResize` (A13): a single raw-key
// pipeline drives every control and imperatively scrolls the timeline window,
// while `size`/`onResize` feed the layout breakpoints and the viewport height the
// pure timeline model (run-timeline.ts) windows over. It hosts two write surfaces:
// the Review checkpoint interaction (#92), which while the `answer-human-gate`
// offer is live replaces the bottom footer with two consequence-stating controls
// that dispatch over run-view's `answer` seam; and the Run Actions (#92 ticket,
// resume/cancel/delete), which render as offer-gated controls dispatching over the
// separate run-actions submit seam (run-actions-view.ts) — cancel and delete
// confirm first since they are irreversible. The Renderer Port stays
// lifecycle-only elsewhere (see tui/AGENTS.md).
//
// The scroll/follow/anchor/new-activity mechanics are hand-rolled over the event
// array rather than OpenTUI's `<scrollbox>` (which OpenCode's session timeline
// uses at 1ead9e3d7f) because the new-activity count and the append anchor are
// net-new (they don't exist upstream) and need event-index control the
// scrollbox's pixel offset does not give.

const HEADER_COMPACT_WIDTH = 80;
const DETAILS_MIN_WIDTH = 60;
const DETAILS_HEIGHT = 8;
/** Rows the Review checkpoint interaction occupies when it replaces the footer
 *  (#92): facts, the latest verdict, the evidence line, two controls each with
 *  their consequence, and a status/hint line. Fixed so the timeline viewport
 *  shrinks to fit and nothing overflows. */
const CHECKPOINT_HEIGHT = 8;

const STEP_GLYPH: Record<RunStepStatus, string> = {
  pending: "·",
  running: "…",
  succeeded: "✓",
  failed: "✗",
  blocked: "⏸",
};

type Focus = "timeline" | "details" | "checkpoint";

export function RunWorkbench(props: {
  runId: string;
  renderer: RendererPort;
  onLeave: () => void;
  onDeleted: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const view = useRunWorkbenchView();
  const actions = useRunActionsView();
  const opened = view.openRun(props.runId);
  const snapshot = opened.snapshot;
  const live = opened.live;
  const preview = opened.preview;

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
  const blockedBasis = () => {
    const current = run();
    if ((live()?.outstanding.length ?? 0) > 0)
      return "ephemeral Harness Request";
    if (current?.state !== "blocked") return undefined;
    if (current.pendingGate !== undefined || current.checkpoint !== undefined)
      return "durable Human Gate";
    if (current.progress[current.position]?.kind === "interactive-agent")
      return "interactive Turn";
    return undefined;
  };

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
  const [control, setControl] = createSignal<"continue" | "stop">("continue");
  const [answerOutcome, setAnswerOutcome] =
    createSignal<Accessor<AnswerOutcome>>();
  const [answerRefusal, setAnswerRefusal] = createSignal<Problem | undefined>();

  // Run Actions (resume/cancel/delete): a control renders — and its key
  // dispatches — iff its Offer is present, legality decided inside Secant (resume
  // on halted/failed; cancel while live, delete while not; #86, #87), so the
  // Workbench never re-derives it. `actionRefusal` shows a refused dispatch;
  // `pending` arms the confirming keypress a takeover, cancel, or delete requires.
  const offers = createMemo(() => {
    const list = run()?.actionOffers ?? [];
    return {
      resume: list.find(
        (offer): offer is ResumeRunOffer => offer.action === "resume-run",
      ),
      cancel: list.find(
        (offer): offer is CancelRunOffer => offer.action === "cancel-run",
      ),
      remove: list.find(
        (offer): offer is DeleteRunOffer => offer.action === "delete-run",
      ),
    };
  });
  const [actionRefusal, setActionRefusal] = createSignal<Problem | undefined>();
  const [pending, setPending] = createSignal<
    "takeover" | "cancel" | "delete" | undefined
  >();
  // A dispatched Run Action followed to settlement: resume drives execution and a
  // cancel-as-abort aborts a live Run, both asynchronous now (#98), so the outcome
  // starts `pending` and the effect below reports it. A second dispatch while one
  // is in flight is ignored.
  const [actionFlight, setActionFlight] = createSignal<{
    readonly op: "resume" | "cancel" | "delete";
    readonly outcome: Accessor<RunActionOutcome>;
  }>();
  const actionInFlight = () => {
    const flight = actionFlight();
    return flight !== undefined && flight.outcome().kind === "pending";
  };

  const dispatchResume = () => {
    const offer = offers().resume;
    if (offer === undefined || actionInFlight()) return;
    setActionRefusal(undefined);
    setActionFlight({ op: "resume", outcome: actions.resume(offer) });
  };
  // Called on the confirming keypress. Cancel keeps the Run's history; delete
  // removes it and leaves the Workbench for the list once it settles, since the
  // Run is then gone.
  const confirmCancel = () => {
    const offer = offers().cancel;
    if (offer === undefined || actionInFlight()) return;
    setActionRefusal(undefined);
    setActionFlight({ op: "cancel", outcome: actions.cancel(offer.runId) });
  };
  const confirmDelete = () => {
    const offer = offers().remove;
    if (offer === undefined || actionInFlight()) return;
    setActionRefusal(undefined);
    setActionFlight({ op: "delete", outcome: actions.remove(offer.runId) });
  };
  const anyActionOffer = () => {
    const current = offers();
    return (
      current.resume !== undefined ||
      current.cancel !== undefined ||
      current.remove !== undefined
    );
  };
  const actionLines = () => {
    const current = offers();
    const count =
      (current.resume ? 1 : 0) +
      (current.cancel ? 1 : 0) +
      (current.remove ? 1 : 0);
    if (count === 0) return 0;
    return (
      1 /*heading*/ +
      count +
      (pending() !== undefined ? 1 : 0) +
      (actionRefusal() !== undefined ? 1 : 0)
    );
  };

  const transcriptTarget = createMemo<Openable | undefined>(() => {
    const current = run();
    return current?.transcript !== undefined && current.transcript.length > 0
      ? { label: "Session transcript", content: transcriptText(current) }
      : undefined;
  });

  // The evidence the details panel offers, in a stable order: bound outputs,
  // then a blocked checkpoint's latest Verdict, a halt diagnostic, and transcript.
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
    const transcript = transcriptTarget();
    if (transcript !== undefined) list.push(transcript);
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
  // The reference-inspection overlay (A26): its state, key loop, and view live in
  // run-inspection; the Workbench selects which evidence to open and hands it here.
  const inspection = createInspection({
    readResource: view.readResource,
    interiorH,
  });
  const hasConflict = () => run()?.conflict !== undefined;
  const compactHeader = () => dims().width < HEADER_COMPACT_WIDTH;
  const headerRows = () => {
    const hasHarness =
      run()?.effectiveModel !== undefined || (run()?.sessions?.length ?? 0) > 0;
    return compactHeader() ? (hasHarness ? 2 : 1) : hasHarness ? 3 : 2;
  };
  const hasGateLine = () =>
    run()?.checkpoint !== undefined || run()?.pendingGate !== undefined;
  const chrome = () =>
    headerRows() +
    (hasGateLine() ? 1 : 0) +
    (hasConflict() ? 1 : 0) /*top-level conflict line (A13)*/ +
    1 /*progress*/ +
    actionLines() +
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

  // Follow a dispatched Run Action to settlement. A refusal surfaces in the
  // Actions section; an applied delete leaves the Workbench for the list (the Run
  // is gone), while resume/cancel just let the live `run` snapshot carry the new
  // state in.
  createEffect(() => {
    const flight = actionFlight();
    if (flight === undefined) return;
    const settled = flight.outcome();
    if (settled.kind === "pending") return;
    if (settled.kind === "refused") {
      setActionRefusal(settled.problem);
      setActionFlight(undefined);
    } else {
      setActionFlight(undefined);
      if (flight.op === "delete") props.onDeleted();
    }
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

  const timelineRows = createMemo<readonly TimelineRow[]>(() => {
    const current = run();
    if (current === undefined) return [];
    return buildTimelineRows(current, live(), preview());
  });
  const win = () =>
    timelineWindow(scroll(), timelineRows().length, viewportH());
  const visibleRows = () => {
    const w = win();
    return timelineRows().slice(w.top, w.top + w.visible);
  };

  const scrollBy = (action: TimelineAction) =>
    setScroll((prev) =>
      scrollTimeline(prev, action, timelineRows().length, viewportH()),
    );

  const moveSelection = (delta: number) => {
    const count = openables().length;
    if (count === 0) return;
    setSelected((index) => Math.max(0, Math.min(index + delta, count - 1)));
  };

  const openSelected = () => {
    const target = openables()[selectedRef()];
    if (target !== undefined) inspection.open(target);
  };

  const handleKey = (key: RendererKeyEvent) => {
    if (dialog.stack.length > 0) return;
    const name = key.name ?? "";
    if (name === "q" || (name === "c" && key.ctrl)) {
      exit();
      return;
    }
    // Inspection overlay owns its own key loop while open (A26): it consumes the
    // key (scroll or Escape-to-close) and reports that it did.
    if (inspection.handleKey(name)) return;
    if (run() === undefined) {
      if (name === "escape") props.onLeave();
      return;
    }
    if (name === "t") {
      const target = transcriptTarget();
      if (target !== undefined) inspection.open(target);
      return;
    }
    // A pending takeover/Cancel/Delete waits for its confirming keypress: `y` confirms and
    // Escape backs out (without dispatching or leaving); any other key is ignored
    // while the confirmation stays armed, so a stray keystroke never dispatches it.
    if (pending() !== undefined) {
      if (name === "y") {
        const action = pending();
        setPending(undefined);
        if (action === "takeover") dispatchResume();
        else if (action === "cancel") confirmCancel();
        else confirmDelete();
      } else if (name === "escape") {
        setPending(undefined);
      }
      return;
    }
    // Run Actions from any focus, gated on the Offer being present. A local resume
    // dispatches at once; takeover, Cancel, and Delete arm a confirmation first.
    if (name === "r" && offers().resume !== undefined) {
      if (offers().resume?.takeover === undefined) dispatchResume();
      else {
        setActionRefusal(undefined);
        setPending("takeover");
      }
      return;
    }
    if (name === "c" && offers().cancel !== undefined) {
      setActionRefusal(undefined);
      setPending("cancel");
      return;
    }
    if (name === "x" && offers().remove !== undefined) {
      setActionRefusal(undefined);
      setPending("delete");
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
        const action = SCROLL_KEYS[name];
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
        <Match when={inspection.inspecting()}>
          {(current) => (
            <InspectionView
              inspection={current()}
              lines={inspection.lines}
              window={inspection.window}
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
              visibleRows={visibleRows}
              blockedBasis={blockedBasis}
              focus={focus}
              openables={openables}
              transcriptAvailable={() => transcriptTarget() !== undefined}
              selected={selectedRef}
              checkpointActive={checkpointActive}
              offer={answerOffer}
              evidence={evidenceLabels}
              control={control}
              answerPending={answerPending}
              answerRefusal={answerRefusal}
              actionOffers={offers}
              anyActionOffer={anyActionOffer}
              actionRefusal={actionRefusal}
              actionPending={pending}
              theme={theme}
            />
          )}
        </Match>
      </Switch>
    </box>
  );
}

type Theme = ReturnType<typeof useTheme>["theme"];

function stateColor(theme: Theme, state: RunStateName) {
  // Typed over RunStateName so the compiler rejects a state string outside the
  // vocabulary (#98 AC6): a new state must be given a colour here to compile.
  switch (state) {
    case "succeeded":
      return theme.success;
    case "failed":
      return theme.error;
    case "cancelled":
      return theme.textMuted;
    case "blocked":
    case "halted":
      return theme.warning;
    case "running":
      return theme.accent;
  }
}

function positionText(run: RunView): string {
  return run.position >= run.progress.length
    ? "at rest"
    : `step ${run.position + 1} of ${run.progress.length}`;
}

function livenessText(run: RunView): string {
  switch (run.liveness.state) {
    case "not-live":
      return "not live";
    case "live-here":
      return `live in this instance (process ${run.liveness.ownerPid})`;
    case "live-elsewhere":
      return `live in another instance (process ${run.liveness.ownerPid})`;
  }
}

function transcriptText(run: RunView): string {
  return (run.transcript ?? [])
    .flatMap((entry) => [
      `${entry.role === "user" ? "◇ User Turn" : "◆ Assistant"} · session ${entry.session}`,
      ...entry.content.split(/\r?\n/).map((line) => `  ${line}`),
    ])
    .join("\n");
}

function Workbench(props: {
  run: Accessor<RunView>;
  compactHeader: Accessor<boolean>;
  detailsShown: Accessor<boolean>;
  detailsHeight: number;
  viewportH: Accessor<number>;
  innerW: Accessor<number>;
  win: Accessor<ReturnType<typeof timelineWindow>>;
  visibleRows: Accessor<readonly TimelineRow[]>;
  blockedBasis: Accessor<string | undefined>;
  focus: Accessor<Focus>;
  openables: Accessor<readonly Openable[]>;
  transcriptAvailable: Accessor<boolean>;
  selected: Accessor<number>;
  checkpointActive: Accessor<boolean>;
  offer: Accessor<AnswerHumanGateOffer | undefined>;
  evidence: Accessor<readonly string[]>;
  control: Accessor<"continue" | "stop">;
  answerPending: Accessor<boolean>;
  answerRefusal: Accessor<Problem | undefined>;
  actionOffers: Accessor<{
    resume?: ResumeRunOffer;
    cancel?: CancelRunOffer;
    remove?: DeleteRunOffer;
  }>;
  anyActionOffer: Accessor<boolean>;
  actionRefusal: Accessor<Problem | undefined>;
  actionPending: Accessor<"takeover" | "cancel" | "delete" | undefined>;
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

  const footer = () => {
    const transcript = props.transcriptAvailable() ? " · t transcript" : "";
    return props.focus() === "details"
      ? `↑/↓ select · enter open${transcript} · tab timeline · esc back · q quit`
      : `↑/↓ scroll · d details${transcript} · end latest · esc back · q quit`;
  };

  const displayState = () =>
    props.blockedBasis() === "ephemeral Harness Request"
      ? "BLOCKED"
      : run().state.toUpperCase();
  const stateWithBasis = () =>
    props.blockedBasis() === undefined
      ? displayState()
      : `${displayState()} · ${props.blockedBasis()}`;
  const harnessLine = () => {
    if (
      run().effectiveModel === undefined &&
      (run().sessions?.length ?? 0) === 0
    )
      return undefined;
    return `Claude Code · model ${run().effectiveModel ?? "not reported"}`;
  };

  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* Compact header: Bundle name, Run id, state in words as well as colour. */}
      <box flexDirection="column" flexShrink={0}>
        <Show
          when={!props.compactHeader()}
          fallback={
            <text fg={stateColor(theme, run().state)}>
              {clip(
                `Run ${run().runId} — ${stateWithBasis()} · ${livenessText(run())}`,
                w(),
              )}
            </text>
          }
        >
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {clip(`${run().bundle.name} — ${stateWithBasis()}`, w())}
          </text>
          <text fg={theme.textMuted}>
            {clip(
              `Run ${run().runId} · ${positionText(run())} · ${livenessText(run())}`,
              w(),
            )}
          </text>
        </Show>
        <Show when={harnessLine()}>
          {(line) => <text fg={theme.textMuted}>{clip(line(), w())}</text>}
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
      <Show when={run().pendingGate}>
        {(gate) => (
          <text fg={theme.warning} flexShrink={0}>
            {clip(`◆ Human Gate · ${gate().message}`, w())}
          </text>
        )}
      </Show>

      {/* A Run halted on a Materialization conflict names the Workspace path to
          restore at the top level, beside the checkpoint line (A13) — the detail
          diagnostic stays behind its reference in the Details panel. */}
      <Show when={run().conflict}>
        {(conflict) => (
          <text fg={theme.warning} flexShrink={0}>
            {clip(`✗ conflict — restore ${conflict().path}`, w())}
          </text>
        )}
      </Show>

      {/* Always-visible Workflow progress, readable without colour via glyphs. */}
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(progressLine(run().progress), w())}
      </text>

      {/* Run Actions: each control shows only while its Offer is present, with the
          consequence the Offer names verbatim and its shortcut. Takeover,
          Cancel, and Delete arm a confirming keypress first. */}
      <Show when={props.anyActionOffer()}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={theme.textMuted} flexShrink={0}>
            {clip("Actions:", w())}
          </text>
          <Show when={props.actionOffers().resume}>
            {(offer) => (
              <text fg={theme.text} flexShrink={0}>
                {clip(`  r resume — ${offer().consequence}`, w())}
              </text>
            )}
          </Show>
          <Show when={props.actionOffers().cancel}>
            {(offer) => (
              <text fg={theme.text} flexShrink={0}>
                {clip(`  c cancel — ${offer().consequence}`, w())}
              </text>
            )}
          </Show>
          <Show when={props.actionOffers().remove}>
            {(offer) => (
              <text fg={theme.text} flexShrink={0}>
                {clip(`  x delete — ${offer().consequence}`, w())}
              </text>
            )}
          </Show>
          <Show when={props.actionPending()}>
            {(action) => (
              <text fg={theme.warning} flexShrink={0}>
                {clip(
                  action() === "takeover"
                    ? `  ⚠ Take over from process ${props.actionOffers().resume?.takeover?.ownerPid ?? "unknown"}? Press y to confirm · esc to keep`
                    : action() === "delete"
                      ? "  ⚠ Delete is permanent (Workspace files are kept). Press y to confirm · esc to keep"
                      : "  ⚠ Cancel ends the Run (history is kept). Press y to confirm · esc to keep",
                  w(),
                )}
              </text>
            )}
          </Show>
          <Show when={props.actionRefusal()}>
            {(problem) => (
              <text fg={theme.error} flexShrink={0}>
                {clip(`  ✗ ${problem().explanation}`, w())}
              </text>
            )}
          </Show>
        </box>
      </Show>

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
          when={props.visibleRows().length > 0}
          fallback={
            <text fg={theme.textMuted} flexShrink={0}>
              {"  (no activity yet)"}
            </text>
          }
        >
          <For each={props.visibleRows()}>
            {(row) => (
              <text fg={theme.text} flexShrink={0}>
                {clip(`  ${row.text}`, w())}
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
