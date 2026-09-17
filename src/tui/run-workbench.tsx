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
  AnswerHarnessRequestOffer,
  AnswerHumanGateOffer,
  ApprovalDecisionName,
  CancelRunOffer,
  DeleteRunOffer,
  EndInteractiveStepOffer,
  InterruptTurnOffer,
  Problem,
  ResumeRunOffer,
  RunCheckpointView,
  RunGateReference,
  RunOutstandingRequest,
  RunStateName,
  RunStepProgress,
  RunStepStatus,
  SteerTurnOffer,
  RunView,
  SendInteractiveTurnOffer,
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
import {
  buildTimelineRows,
  oneLine,
  type TimelineRow,
} from "./run-timeline-rows.js";
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
/** Rows the interactive-agent input occupies when it replaces the footer (#122):
 *  a label, the draft input line, and a hint/status line, plus one for a refusal.
 *  Fixed so the timeline viewport shrinks to fit and nothing overflows. */
const INTERACTIVE_HEIGHT = 4;
/** Rows the approval Harness Request control occupies while it replaces the footer
 *  (#121, spec story 13/14): a heading, the exact tool, the exact input, the
 *  allow/deny decisions, and a status/hint line that also carries a stale refusal. */
const REQUEST_HEIGHT = 5;
/** Rows the free-text Human Gate control occupies while it replaces the footer
 *  (#121, spec story 17): the gate message, the declared output name, the text
 *  entry line, and a status/hint line. */
const GATE_HEIGHT = 4;

/** An empty free-text answer is refused in the client before any dispatch (#121
 *  AC3): the Port would accept `text: ""`, but the Workbench never sends a blank. */
const EMPTY_GATE_ANSWER: Problem = {
  code: "gate-answer-empty",
  explanation: "A free-text answer cannot be empty.",
  remediation: "Type an answer, then press enter.",
  possibleEffects: "none",
};

const STEP_GLYPH: Record<RunStepStatus, string> = {
  pending: "·",
  running: "…",
  succeeded: "✓",
  failed: "✗",
  blocked: "⏸",
};

type Focus = "timeline" | "details" | "checkpoint" | "interactive";

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

  // The first outstanding approval Harness Request paired with its live answer
  // Offer (#117): both ride the ephemeral overlay, so the control exists only while
  // the Turn holds the request and vanishes the instant the Turn settles, is
  // interrupted, or is lost — the request is never re-asked (spec story 15). Several
  // may be outstanding; the control answers them one at a time, first outstanding
  // first, and the next surfaces once this one clears.
  const liveRequest = createMemo<
    | { request: RunOutstandingRequest; offer: AnswerHarnessRequestOffer }
    | undefined
  >(() => {
    const overlay = live();
    if (overlay === undefined) return undefined;
    const request = overlay.outstanding[0];
    if (request === undefined) return undefined;
    const offer = overlay.offers.find(
      (candidate) => candidate.requestId === request.requestId,
    );
    return offer !== undefined ? { request, offer } : undefined;
  });

  // A blocked Run resting at an authored free-text Human Gate (#108, spec story 17),
  // backed by its live answer-human-gate Offer. Distinct from the derived Review
  // checkpoint (approve-reject) the CheckpointInteraction handles; an authored
  // approve-reject gate keeps M2's headless answer path — no new TUI control here.
  const freeTextGate = createMemo<
    { gate: RunGateReference; message: string; outputName?: string } | undefined
  >(() => {
    const pending = run()?.pendingGate;
    if (pending === undefined || pending.gate.shape !== "free-text")
      return undefined;
    if (answerOffer() === undefined) return undefined;
    return {
      gate: pending.gate,
      message: pending.message,
      ...(pending.outputArtifactName !== undefined
        ? { outputName: pending.outputArtifactName }
        : {}),
    };
  });

  // A request or free-text gate control owns the whole bottom interaction while it
  // is up: it captures Esc and every printable key, so the global Run Actions (r/c/x)
  // and the Esc interrupt are inert and must not be shown. The interrupt/steer offers
  // stay present through an `awaiting-approval` Turn (run-projection derives them from
  // liveness alone), so without this guard the request modal and the "esc esc
  // interrupt" hint would collide over Esc.
  const modalControl = () =>
    liveRequest() !== undefined || freeTextGate() !== undefined;

  const [scroll, setScroll] = createSignal<TimelineScroll>(AT_LIVE);
  const [focus, setFocus] = createSignal<Focus>("timeline");
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [selected, setSelected] = createSignal(0);
  const [control, setControl] = createSignal<"continue" | "stop">("continue");
  const [answerOutcome, setAnswerOutcome] =
    createSignal<Accessor<AnswerOutcome>>();
  const [answerRefusal, setAnswerRefusal] = createSignal<Problem | undefined>();

  // Approval Harness Request control state (#117): the selected decision, the
  // in-flight answer, and a stale/rejected refusal shown inline while the current
  // offer (bumped to the fresh generation) re-renders.
  const [requestDecision, setRequestDecision] =
    createSignal<ApprovalDecisionName>("allow");
  const [requestOutcome, setRequestOutcome] =
    createSignal<Accessor<AnswerOutcome>>();
  const [requestRefusal, setRequestRefusal] = createSignal<
    Problem | undefined
  >();
  const requestPending = () => {
    const accessor = requestOutcome();
    return accessor !== undefined && accessor().kind === "pending";
  };

  // Free-text Human Gate control state (#108): the typed answer, the in-flight
  // submission, and a refusal (an empty answer refused locally, or a Port refusal).
  const [gateText, setGateText] = createSignal("");
  const [gateOutcome, setGateOutcome] = createSignal<Accessor<AnswerOutcome>>();
  const [gateRefusal, setGateRefusal] = createSignal<Problem | undefined>();
  const gatePending = () => {
    const accessor = gateOutcome();
    return accessor !== undefined && accessor().kind === "pending";
  };

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
      // Turn-scoped controls (#118), present only while a Turn is live in this
      // process: interrupt is a real dispatch; steer is offered unavailable and
      // never dispatches.
      interrupt: list.find(
        (offer): offer is InterruptTurnOffer =>
          offer.action === "interrupt-turn",
      ),
      steer: list.find(
        (offer): offer is SteerTurnOffer => offer.action === "steer-turn",
      ),
    };
  });
  const [actionRefusal, setActionRefusal] = createSignal<Problem | undefined>();
  const [pending, setPending] = createSignal<
    "takeover" | "cancel" | "delete" | "end-step" | undefined
  >();
  // A dispatched Run Action followed to settlement: resume drives execution and a
  // cancel-as-abort aborts a live Run, both asynchronous now (#98), so the outcome
  // starts `pending` and the effect below reports it. A second dispatch while one
  // is in flight is ignored.
  const [actionFlight, setActionFlight] = createSignal<{
    readonly op: "resume" | "cancel" | "delete" | "interrupt";
    readonly outcome: Accessor<RunActionOutcome>;
  }>();
  // The Interrupt is a two-press bound key (Esc while a Turn is live, spec story 18):
  // the first press arms it and shows the hint, the second dispatches. It disarms on
  // any other key and whenever the live-Turn Offer disappears.
  const [interruptArmed, setInterruptArmed] = createSignal(false);
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
  const dispatchInterrupt = () => {
    const offer = offers().interrupt;
    if (offer === undefined || actionInFlight()) return;
    setActionRefusal(undefined);
    setActionFlight({ op: "interrupt", outcome: actions.interrupt(offer) });
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
    if (modalControl()) return false; // a request/gate modal hides the Actions rail
    const current = offers();
    return (
      current.resume !== undefined ||
      current.cancel !== undefined ||
      current.remove !== undefined ||
      current.interrupt !== undefined ||
      current.steer !== undefined
    );
  };
  const actionLines = () => {
    if (modalControl()) return 0;
    const current = offers();
    // Interrupt/steer are agent-Turn controls hidden while the interactive input owns
    // the interaction (its Esc leaves, not interrupts), so they must not be counted.
    const liveTurn = interactiveStepActive()
      ? 0
      : (current.interrupt ? 1 : 0) + (current.steer ? 1 : 0);
    const count =
      (current.resume ? 1 : 0) +
      (current.cancel ? 1 : 0) +
      (current.remove ? 1 : 0) +
      liveTurn;
    if (count === 0) return 0;
    return (
      1 /*heading*/ +
      count +
      (!interactiveStepActive() && interruptArmed()
        ? 1
        : 0) /*the "again to interrupt" hint*/ +
      (pending() !== undefined ? 1 : 0) +
      (actionRefusal() !== undefined ? 1 : 0)
    );
  };

  // Interactive-agent turn-taking (#122): the Workbench hands the bottom input to
  // the human while the Run rests `blocked` at an interactive-agent Step. The Step is
  // active whenever the Run is blocked there (not a gate/checkpoint), independent of
  // whether a Turn is live, so focus stays on the input across the whole Step. `send`
  // and `end` offers are present only at a Turn boundary (no live Turn), so they gate
  // whether Enter dispatches and whether End Step is armable.
  const interactiveStepActive = () => {
    const current = run();
    // `blocked` is the boundary (between Turns); `running` is a live human Turn (the
    // Run runs under `running` while a Turn is in flight, #122). Focus stays on the
    // input across both. Guarded on the Step kind, so ordinary agent-step execution
    // (also `running`, but kind `agent`) never shows the input.
    return (
      (current?.state === "blocked" || current?.state === "running") &&
      current.checkpoint === undefined &&
      current.pendingGate === undefined &&
      current.progress[current.position]?.kind === "interactive-agent"
    );
  };
  const interactiveOffers = createMemo(() => {
    const list = run()?.actionOffers ?? [];
    return {
      send: list.find(
        (offer): offer is SendInteractiveTurnOffer =>
          offer.action === "send-interactive-turn",
      ),
      end: list.find(
        (offer): offer is EndInteractiveStepOffer =>
          offer.action === "end-interactive-step",
      ),
    };
  });
  // A Turn is live (working) when the Step is active but the boundary offers are gone.
  const interactiveTurnLive = () =>
    interactiveStepActive() && interactiveOffers().send === undefined;
  const [draft, setDraft] = createSignal("");
  const [interactiveOutcome, setInteractiveOutcome] =
    createSignal<Accessor<AnswerOutcome>>();
  const [interactiveRefusal, setInteractiveRefusal] = createSignal<
    Problem | undefined
  >();
  const interactivePending = () => {
    const accessor = interactiveOutcome();
    return accessor !== undefined && accessor().kind === "pending";
  };

  const dispatchSend = () => {
    const offer = interactiveOffers().send;
    if (offer === undefined || interactivePending()) return;
    // Secant authors nothing: a blank or whitespace-only Turn is not sent (AC1).
    if (draft().trim() === "") return;
    setInteractiveRefusal(undefined);
    const text = draft();
    setDraft("");
    setInteractiveOutcome(() =>
      view.sendInteractiveTurn(offer.runId, offer.stepId, text),
    );
  };
  const confirmEndStep = () => {
    const offer = interactiveOffers().end;
    if (offer === undefined || interactivePending()) return;
    setInteractiveRefusal(undefined);
    setInteractiveOutcome(() =>
      view.endInteractiveStep(offer.runId, offer.stepId),
    );
  };

  // One transcript openable per Session that has a recorded transcript (#124),
  // each opening that Session's newest page through its `page` Resource Reference.
  const transcriptTargets = createMemo<readonly Openable[]>(() => {
    const sessions = run()?.sessions ?? [];
    const withTranscript = sessions.filter(
      (s) => s.transcriptPage !== undefined,
    );
    return withTranscript.map((s) => ({
      label:
        withTranscript.length > 1
          ? `Session transcript · ${s.session}`
          : "Session transcript",
      transcript: s.transcriptPage!,
    }));
  });
  // The `t` shortcut and transcript-available hint follow the first Session.
  const transcriptTarget = createMemo<Openable | undefined>(
    () => transcriptTargets()[0],
  );

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
    list.push(...transcriptTargets());
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
    readTranscript: view.readTranscript,
    interiorH,
  });
  const hasConflict = () => run()?.conflict !== undefined;
  const compactHeader = () => dims().width < HEADER_COMPACT_WIDTH;
  const headerRows = () => {
    // The Harness identity line renders exactly when the durable `harness` view is
    // present (#125) — one extra header row in either layout.
    const hasHarness = run()?.harness !== undefined;
    return compactHeader() ? (hasHarness ? 2 : 1) : hasHarness ? 3 : 2;
  };
  const hasGateLine = () =>
    run()?.checkpoint !== undefined || run()?.pendingGate !== undefined;
  // The bottom region is one of, in precedence: the approval request control, the
  // free-text gate control, the Review checkpoint interaction, the interactive-agent
  // input, or the plain footer — each replacing the passive footer while its offer is
  // live (#92, #121, #122). A Run rests at only one, so they never render together.
  const bottomHeight = () =>
    liveRequest() !== undefined
      ? REQUEST_HEIGHT
      : freeTextGate() !== undefined
        ? GATE_HEIGHT
        : checkpointActive()
          ? CHECKPOINT_HEIGHT
          : interactiveStepActive()
            ? INTERACTIVE_HEIGHT
            : 1;
  const chrome = () =>
    headerRows() +
    (hasGateLine() ? 1 : 0) +
    (hasConflict() ? 1 : 0) /*top-level conflict line (A13)*/ +
    1 /*progress*/ +
    actionLines() +
    1 /*timeline label*/ +
    bottomHeight();
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

  // One settle-and-clear follow shared by the three write seams (answer, request,
  // gate): a refusal surfaces and re-enables the control, then the in-flight outcome
  // clears. An applied answer clears too — the live snapshot drops the offer, so each
  // control disappears on its own.
  const followSettlement = (
    outcome: Accessor<Accessor<AnswerOutcome> | undefined>,
    clear: () => void,
    setRefusal: (problem: Problem) => void,
  ) =>
    createEffect(() => {
      const accessor = outcome();
      if (accessor === undefined) return;
      const settled = accessor();
      if (settled.kind === "pending") return;
      if (settled.kind === "refused") setRefusal(settled.problem);
      clear();
    });

  // Run `reset` whenever a control's identity changes — a fresh request id or a fresh
  // gate Attempt — so a re-block never inherits the previous interaction's local
  // state. (The checkpoint has its own keyed effect below; it also moves focus.)
  const onIdentityChange = (identity: Accessor<string>, reset: () => void) => {
    let last = "";
    createEffect(() => {
      const current = identity();
      if (current !== last) {
        last = current;
        reset();
      }
    });
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

  // Follow the answer to its settlement (a stale Gate or a Run no longer blocked
  // surfaces as a refusal that re-enables the controls).
  followSettlement(
    answerOutcome,
    () => setAnswerOutcome(undefined),
    setAnswerRefusal,
  );

  // Answer the outstanding approval Harness Request with a decision (#117). A stale
  // generation settles refused — the Application decides, never the client — and the
  // control stays up on the fresh generation with the Problem shown inline (AC2).
  const dispatchRequestAnswer = (decision: ApprovalDecisionName) => {
    if (requestPending()) return;
    const current = liveRequest();
    if (current === undefined) return;
    setRequestRefusal(undefined);
    setRequestOutcome(() => view.answerRequest(current.offer, decision));
  };
  followSettlement(
    requestOutcome,
    () => setRequestOutcome(undefined),
    setRequestRefusal,
  );
  // A genuinely new request (a fresh requestId) resets the decision to the safer
  // allow and clears any prior refusal; a stale answer keeps the same id, so its
  // inline refusal survives while the bumped-generation offer re-renders (AC2).
  onIdentityChange(
    () => liveRequest()?.request.requestId ?? "",
    () => {
      setRequestDecision("allow");
      setRequestRefusal(undefined);
    },
  );

  // Submit the free-text gate answer (#108). An empty answer is refused locally with
  // no dispatch (AC3); the open snapshot follows the Run leaving `blocked`, so the
  // control disappears on its own once the answer applies.
  const dispatchGateText = () => {
    if (gatePending()) return;
    const current = freeTextGate();
    if (current === undefined) return;
    if (gateText().trim().length === 0) {
      setGateRefusal(EMPTY_GATE_ANSWER);
      return;
    }
    setGateRefusal(undefined);
    setGateOutcome(() => view.answerText(current.gate, gateText()));
  };
  followSettlement(
    gateOutcome,
    () => setGateOutcome(undefined),
    setGateRefusal,
  );
  // A fresh gate (a different producing Attempt) clears the typed buffer and any
  // refusal so a re-block never inherits the previous gate's half-typed answer.
  onIdentityChange(
    () => {
      const current = freeTextGate();
      return current !== undefined
        ? `${current.gate.stepId}:${current.gate.attemptId}`
        : "";
    },
    () => {
      setGateText("");
      setGateRefusal(undefined);
    },
  );
  // The Interrupt disarms whenever the live-Turn Offer leaves (the Turn settled or
  // was lost) or a request/gate modal takes over, so a stale "again to interrupt"
  // hint never lingers under the request control that now owns Esc.
  createEffect(() => {
    if (
      (offers().interrupt === undefined || modalControl()) &&
      interruptArmed()
    )
      setInterruptArmed(false);
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

  // Focus lands on the interactive input while the Run rests at an interactive Step
  // and returns to the timeline when the Step ends (#122 AC), keyed on the Step so a
  // fresh interactive Step re-focuses and clears the draft. It does not yank focus
  // back while the user has tabbed away during the same Step.
  let lastInteractiveStep = "";
  createEffect(() => {
    const active = interactiveStepActive();
    const current = run();
    const stepId =
      active && current !== undefined
        ? (current.progress[current.position]?.id ?? "")
        : "";
    if (active && stepId !== lastInteractiveStep) {
      setFocus("interactive");
      setDraft("");
      setInteractiveRefusal(undefined);
    } else if (!active && focus() === "interactive") {
      setFocus("timeline");
    }
    lastInteractiveStep = active ? stepId : "";
  });

  // Follow a sent Turn / End Step to settlement: a refusal (a Turn still live, a
  // stale Step) surfaces in the input and re-enables it; an applied outcome just
  // clears local state — the live snapshot carries the new transcript / advance in.
  createEffect(() => {
    const accessor = interactiveOutcome();
    if (accessor === undefined) return;
    const settled = accessor();
    if (settled.kind === "pending") return;
    if (settled.kind === "refused") setInteractiveRefusal(settled.problem);
    setInteractiveOutcome(undefined);
  });

  // Tab cycles the focusable regions in a stable order: the checkpoint or interactive
  // input (while active), the timeline, then the details panel (while shown).
  const focusOrder = (): Focus[] => {
    const order: Focus[] = [];
    if (checkpointActive()) order.push("checkpoint");
    if (interactiveStepActive()) order.push("interactive");
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

  // Accumulate the human's Turn text and drive the interactive controls (#122). The
  // input owns every key while it holds focus (tui/AGENTS: a text field binds no bare
  // letter), so `name` is treated as literal text unless it is a control key: Enter
  // sends, Ctrl+E arms End Step (only at a boundary), Escape leaves, Backspace edits.
  // ponytail: text comes from the key `name`, so a single character types and a few
  // named keys (space) map through; capitals and punctuation the Renderer Port does
  // not name are out of reach until it carries the printable value. Enough to prove
  // the handoff, Enter dispatch, and blank guard the ticket asks for.
  const handleInteractiveKey = (key: RendererKeyEvent) => {
    const name = key.name ?? "";
    if (name === "e" && key.ctrl) {
      // End Step is offered only at a Turn boundary; arm the confirming keypress.
      if (interactiveOffers().end !== undefined) {
        setInteractiveRefusal(undefined);
        setPending("end-step");
      }
      return;
    }
    if (name === "return") {
      dispatchSend();
      return;
    }
    if (name === "escape") {
      props.onLeave();
      return;
    }
    if (name === "backspace") {
      setDraft((text) => text.slice(0, -1));
      return;
    }
    if (name === "space") {
      setDraft((text) => `${text} `);
      return;
    }
    if (name.length === 1) setDraft((text) => text + name);
  };

  const handleKey = (key: RendererKeyEvent) => {
    if (dialog.stack.length > 0) return;
    const name = key.name ?? "";
    if (name === "c" && key.ctrl) {
      exit(); // Ctrl+C always quits, even from a text control
      return;
    }
    // Inspection overlay owns its own key loop while open (A26): it consumes the
    // key (scroll or Escape-to-close) and reports that it did.
    if (inspection.handleKey(name)) return;
    if (run() === undefined) {
      if (name === "escape") props.onLeave();
      return;
    }
    // Approval Harness Request control (#117): modal while a request is outstanding.
    // ←/→ choose the offered decision, enter confirms it, Esc denies. Other keys are
    // swallowed — the prompt input is disabled only while a request is outstanding.
    // The decisions come straight off the current offer (spec story 13: exactly the
    // decisions Claude Code offered — allow/deny), never a paraphrase.
    const request = liveRequest();
    if (request !== undefined) {
      const decisions = request.offer.decisions;
      switch (name) {
        case "left":
          if (!requestPending()) setRequestDecision(decisions[0] ?? "allow");
          return;
        case "right":
          if (!requestPending())
            setRequestDecision(decisions[1] ?? decisions[0] ?? "deny");
          return;
        case "return":
          dispatchRequestAnswer(requestDecision());
          return;
        case "escape":
          dispatchRequestAnswer(
            decisions.includes("deny")
              ? "deny"
              : (decisions[decisions.length - 1] ?? "deny"),
          );
          return;
        default:
          return;
      }
    }
    // Free-text Human Gate control (#108): a hand-rolled text buffer over the raw-key
    // pipeline. The Workbench is Port-driven (tui/AGENTS.md), so a native <input> on
    // the keymap path could not see these keys; enter submits, backspace deletes, Esc
    // leaves, and unbound printable keys append. ponytail: single-char `name` only —
    // shifted symbols and IME are real-terminal input, deferred with the other #23
    // renderer/platform evidence.
    if (freeTextGate() !== undefined) {
      if (name === "return") {
        dispatchGateText();
        return;
      }
      if (name === "escape") {
        props.onLeave();
        return;
      }
      if (gatePending()) return; // buffer frozen while the answer is in flight
      if (name === "backspace" || name === "delete") {
        setGateText((text) => text.slice(0, -1));
        return;
      }
      if (name === "space") {
        setGateText((text) => text + " ");
        return;
      }
      if (name.length === 1 && key.ctrl !== true) {
        setGateText((text) => text + name);
        return;
      }
      return;
    }
    // Beyond the request/gate modals, the interactive input owns keys too (#122): a
    // bare letter typed into a Turn must not fire its command, so `q`/`t` and the
    // Run Actions are gated on not typing.
    const typing = focus() === "interactive" && interactiveStepActive();
    if (name === "q" && !typing) {
      exit(); // quit — never reached inside a text-entry control above
      return;
    }
    if (name === "t" && !typing) {
      const target = transcriptTarget();
      if (target !== undefined) inspection.open(target);
      return;
    }
    // A pending takeover/Cancel/Delete/End-Step waits for its confirming keypress:
    // `y` confirms and Escape backs out (without dispatching or leaving); any other
    // key is ignored while the confirmation stays armed, so a stray keystroke never
    // dispatches it. (It sits ahead of the interactive input so End Step's own
    // confirm suspends typing.)
    if (pending() !== undefined) {
      if (name === "y") {
        const action = pending();
        setPending(undefined);
        if (action === "takeover") dispatchResume();
        else if (action === "cancel") confirmCancel();
        else if (action === "delete") confirmDelete();
        else confirmEndStep();
      } else if (name === "escape") {
        setPending(undefined);
      }
      return;
    }
    // While the interactive input holds focus it owns every remaining key as text or
    // an interactive control, ahead of the bare-letter Run Actions below (#122).
    if (typing) {
      handleInteractiveKey(key);
      return;
    }
    // Interrupt is a two-press Esc while an agent Turn is live (spec story 18): it
    // takes Esc over "leave the Workbench" only while the live-Turn Offer is present
    // and no interactive Step owns the interaction (its Esc leaves, #122). First press
    // arms and shows the hint; second dispatches `interrupt-turn`. Any other key below
    // disarms it, so the hint never lingers.
    if (
      name === "escape" &&
      offers().interrupt !== undefined &&
      !interactiveStepActive()
    ) {
      if (interruptArmed()) {
        setInterruptArmed(false);
        dispatchInterrupt();
      } else {
        setInterruptArmed(true);
      }
      return;
    }
    if (interruptArmed()) setInterruptArmed(false);
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
              // End Step's confirm renders in the interactive input, not the Actions
              // box, so the Actions box never sees the `end-step` pending state.
              actionPending={() => {
                const armed = pending();
                return armed === "end-step" ? undefined : armed;
              }}
              interactiveActive={interactiveStepActive}
              interactiveTurnLive={interactiveTurnLive}
              interactiveEndOffered={() =>
                interactiveOffers().end !== undefined
              }
              interactiveSendOffered={() =>
                interactiveOffers().send !== undefined
              }
              draft={draft}
              endStepArmed={() => pending() === "end-step"}
              interactivePending={interactivePending}
              interactiveRefusal={interactiveRefusal}
              interruptArmed={interruptArmed}
              liveRequest={liveRequest}
              requestDecision={requestDecision}
              requestPending={requestPending}
              requestRefusal={requestRefusal}
              freeTextGate={freeTextGate}
              gateText={gateText}
              gatePending={gatePending}
              gateRefusal={gateRefusal}
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
    interrupt?: InterruptTurnOffer;
    steer?: SteerTurnOffer;
  }>;
  anyActionOffer: Accessor<boolean>;
  actionRefusal: Accessor<Problem | undefined>;
  actionPending: Accessor<"takeover" | "cancel" | "delete" | undefined>;
  interactiveActive: Accessor<boolean>;
  interactiveTurnLive: Accessor<boolean>;
  interactiveEndOffered: Accessor<boolean>;
  interactiveSendOffered: Accessor<boolean>;
  draft: Accessor<string>;
  endStepArmed: Accessor<boolean>;
  interactivePending: Accessor<boolean>;
  interactiveRefusal: Accessor<Problem | undefined>;
  interruptArmed: Accessor<boolean>;
  liveRequest: Accessor<
    | { request: RunOutstandingRequest; offer: AnswerHarnessRequestOffer }
    | undefined
  >;
  requestDecision: Accessor<ApprovalDecisionName>;
  requestPending: Accessor<boolean>;
  requestRefusal: Accessor<Problem | undefined>;
  freeTextGate: Accessor<
    { gate: RunGateReference; message: string; outputName?: string } | undefined
  >;
  gateText: Accessor<string>;
  gatePending: Accessor<boolean>;
  gateRefusal: Accessor<Problem | undefined>;
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
  // The Harness identity that qualified the current or latest Agent-step Attempt (#125):
  // the observed Harness name, resolved executable, and version, with the effective
  // model. Read from the durable `harness` view — never inferred from configuration, so
  // "Claude Code" is no longer hardcoded. A live Turn before its first Attempt settles
  // has a Session but no durable identity yet; the line shows once the Attempt records
  // it. The compact form drops the (long) executable path to stay readable at small
  // widths; no value is invented when the model is unavailable.
  const harnessLine = () => {
    const harness = run().harness;
    if (harness === undefined) return undefined;
    const model = run().effectiveModel ?? "not reported";
    return props.compactHeader()
      ? `${harness.name} · ${harness.executableVersion} · model ${model}`
      : `${harness.name} · ${harness.executable} · ${harness.executableVersion} · model ${model}`;
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
          {/* Interrupt (Esc twice) and Steer, shown only while an agent Turn is live
              and no interactive Step owns the interaction (its Esc leaves, #122).
              Steer names its unavailable reason and never dispatches (story 19). */}
          <Show
            when={!props.interactiveActive() && props.actionOffers().interrupt}
          >
            {(offer) => (
              <text fg={theme.text} flexShrink={0}>
                {clip(`  esc esc interrupt — ${offer().consequence}`, w())}
              </text>
            )}
          </Show>
          <Show when={!props.interactiveActive() && props.actionOffers().steer}>
            {(offer) => (
              <text fg={theme.textMuted} flexShrink={0}>
                {clip(`  steer — unavailable · ${offer().reason}`, w())}
              </text>
            )}
          </Show>
          <Show when={!props.interactiveActive() && props.interruptArmed()}>
            <text fg={theme.warning} flexShrink={0}>
              {clip(
                "  ⚠ Press esc again to interrupt · any other key cancels",
                w(),
              )}
            </text>
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

      {/* The bottom region: one control replaces the passive footer input while its
          offer is live, in precedence — an outstanding approval request, a free-text
          gate, a Review checkpoint, or the interactive-agent input (#92, #108, #117,
          #121, #122). A Run rests at only one, so they never render together. */}
      <Switch
        fallback={
          <Show
            when={props.interactiveActive()}
            fallback={
              <text fg={theme.textMuted} flexShrink={0}>
                {clip(footer(), w())}
              </text>
            }
          >
            <InteractiveInput
              draft={props.draft}
              turnLive={props.interactiveTurnLive}
              endOffered={props.interactiveEndOffered}
              sendOffered={props.interactiveSendOffered}
              endArmed={props.endStepArmed}
              pending={props.interactivePending}
              refusal={props.interactiveRefusal}
              focused={() => props.focus() === "interactive"}
              width={props.innerW}
              theme={theme}
            />
          </Show>
        }
      >
        <Match when={props.liveRequest()}>
          {(current) => (
            <HarnessRequestControl
              request={() => current().request}
              offer={() => current().offer}
              decision={props.requestDecision}
              pending={props.requestPending}
              refusal={props.requestRefusal}
              width={props.innerW}
              theme={theme}
            />
          )}
        </Match>
        <Match when={props.freeTextGate()}>
          {(current) => (
            <FreeTextGateControl
              gate={current}
              text={props.gateText}
              pending={props.gatePending}
              refusal={props.gateRefusal}
              width={props.innerW}
              theme={theme}
            />
          )}
        </Match>
        <Match when={props.checkpointActive() ? run().checkpoint : undefined}>
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
        </Match>
      </Switch>
    </box>
  );
}

/** The interactive-agent human input (#122): a label, the draft Turn text (with a
 *  caret while focused), and a hint/status line — a Turn in progress, the Enter/End
 *  Step controls at a boundary, or the End Step confirm. Every line is plain text so
 *  interactive Turns read distinctly from an agent's without colour (AC2). */
function InteractiveInput(props: {
  draft: Accessor<string>;
  turnLive: Accessor<boolean>;
  endOffered: Accessor<boolean>;
  sendOffered: Accessor<boolean>;
  endArmed: Accessor<boolean>;
  pending: Accessor<boolean>;
  refusal: Accessor<Problem | undefined>;
  focused: Accessor<boolean>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const caret = () => (props.focused() ? "▌" : "");
  const hint = () => {
    if (props.endArmed())
      return "  ⚠ End this interactive Step? Press y to confirm · esc to keep";
    if (props.pending()) return "  … sending…";
    if (props.turnLive()) return "  … a Turn is running — interrupt it to stop";
    if (props.sendOffered())
      return "  enter send Turn · ^E end step · esc back";
    return "  esc back";
  };
  return (
    <box flexDirection="column" flexShrink={0}>
      <text
        fg={props.focused() ? theme.text : theme.textMuted}
        attributes={props.focused() ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip("◇ Your Turn — you are driving this Session", w())}
      </text>
      <text fg={theme.text} flexShrink={0}>
        {clip(`> ${props.draft()}${caret()}`, w())}
      </text>
      <Show
        when={props.refusal()}
        fallback={
          <text fg={theme.textMuted} flexShrink={0}>
            {clip(hint(), w())}
          </text>
        }
      >
        {(problem) => (
          <text fg={theme.error} flexShrink={0}>
            {clip(`  ✗ ${problem().explanation}`, w())}
          </text>
        )}
      </Show>
    </box>
  );
}

/** The approval Harness Request control (#117, spec story 13/14): the exact tool
 *  and input Claude Code asked to run, the exact decisions it offered, and a
 *  status/hint line carrying a pending state or a stale-offer refusal. It replaces
 *  the footer while a request is outstanding; every line is plain text so both
 *  decisions read with colour removed. */
function HarnessRequestControl(props: {
  request: Accessor<RunOutstandingRequest>;
  offer: Accessor<AnswerHarnessRequestOffer>;
  decision: Accessor<ApprovalDecisionName>;
  pending: Accessor<boolean>;
  refusal: Accessor<Problem | undefined>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const decisions = () => props.offer().decisions;
  const marker = (which: ApprovalDecisionName) =>
    props.decision() === which ? "› " : "  ";
  const decisionsLine = () =>
    decisions()
      .map((which) => `${marker(which)}[ ${label(which)} ]`)
      .join("   ");
  const status = () => {
    if (props.pending()) return "… relaying your decision";
    const refusal = props.refusal();
    if (refusal !== undefined)
      return `refused: ${refusal.explanation} ${refusal.remediation}`;
    return "←/→ choose · enter confirm · esc deny · ctrl+c quit";
  };
  return (
    <box
      flexDirection="column"
      height={REQUEST_HEIGHT}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={theme.warning} attributes={TextAttributes.BOLD} flexShrink={0}>
        {clip("› Harness Request · awaiting your approval", w())}
      </text>
      <text fg={theme.text} flexShrink={0}>
        {clip(`  Tool: ${props.request().tool}`, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`  Input: ${oneLine(props.request().input)}`, w())}
      </text>
      <text
        fg={theme.text}
        attributes={props.pending() ? 0 : TextAttributes.BOLD}
        flexShrink={0}
      >
        {clip(
          `  ${decisionsLine()}${props.pending() ? "  (unavailable)" : ""}`,
          w(),
        )}
      </text>
      <text
        fg={props.refusal() !== undefined ? theme.error : theme.textMuted}
        flexShrink={0}
      >
        {clip(`  ${status()}`, w())}
      </text>
    </box>
  );
}

/** The free-text Human Gate control (#108, spec story 17): the gate message, the
 *  declared output the answer binds, a text-entry line with a block caret, and a
 *  status/hint line carrying a pending state or a refusal (empty local or Port). It
 *  replaces the footer while the Run rests blocked at the gate. */
function FreeTextGateControl(props: {
  gate: Accessor<{
    gate: RunGateReference;
    message: string;
    outputName?: string;
  }>;
  text: Accessor<string>;
  pending: Accessor<boolean>;
  refusal: Accessor<Problem | undefined>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const status = () => {
    if (props.pending()) return "… submitting your answer";
    const refusal = props.refusal();
    if (refusal !== undefined)
      return `refused: ${refusal.explanation} ${refusal.remediation}`;
    return "type your answer · enter submit · esc back · ctrl+c quit";
  };
  return (
    <box
      flexDirection="column"
      height={GATE_HEIGHT}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={theme.warning} attributes={TextAttributes.BOLD} flexShrink={0}>
        {clip(`› Human Gate · ${props.gate().message}`, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(
          `  Answer published as: ${props.gate().outputName ?? "the gate's text output"}`,
          w(),
        )}
      </text>
      <text fg={theme.text} flexShrink={0}>
        {clip(`  > ${props.text()}${props.pending() ? "" : "▌"}`, w())}
      </text>
      <text
        fg={props.refusal() !== undefined ? theme.error : theme.textMuted}
        flexShrink={0}
      >
        {clip(`  ${status()}`, w())}
      </text>
    </box>
  );
}

/** The human label for an approval decision (spec story 13). */
function label(decision: ApprovalDecisionName): string {
  return decision === "allow" ? "Allow" : "Deny";
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
