import { randomUUID } from "node:crypto";
import {
  createContext,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type {
  AnswerHarnessRequestOffer,
  ApprovalDecisionName,
  DiagnosticReference,
  OpenedProjection,
  ProjectionPort,
  ProjectionUpdate,
  ResourceRead,
  ResourceReference,
  RunLiveOverlay,
  RunGateReference,
  RunSnapshot,
  TranscriptExportReference,
  TranscriptPageReference,
  TranscriptRead,
} from "../application/projection-port.js";
import {
  followProjectionUpdates,
  type TProjectionStreamHealth,
} from "./follow.js";
import { submitAndSettle, type SettleOutcome } from "./submit-and-settle.js";

// The view-state the Run Workbench renders, mirroring bundle-view.tsx: it opens
// the existing `run` Projection as a *reactive* accessor and follows its durable
// updates on the live edge (each Attempt publication commits a fresh snapshot),
// so the Workbench watches a Run change without ceremony. Distinct from the
// launch seam (run-launch-view.tsx), which reads the Run once to build a receipt.
// It also resolves a `text`/`verdict`/diagnostic Resource Reference on demand, so
// large output is fetched only when the user opens it and never inlined into the
// snapshot (#91 AC4). Built over the Projection Port for production and
// hand-driven with fake `run` snapshots in renderer tests, so the same screens
// serve both. The Workbench's one write is `answer` (#92): it dispatches the
// `answer-human-gate` Operation while the same screen keeps following the `run`
// snapshot live, so the checkpoint interaction disappears as the answer applies.

/** An answer as the Workbench observes it: `pending` until it settles, then
 *  `applied` (the open snapshot then drops the checkpoint and its offer) or a
 *  refusal Problem. This is the shared submit-and-settle outcome (A23). */
export type AnswerOutcome = SettleOutcome;
export type TRunViewFreshness = TProjectionStreamHealth;

/** The durable Run snapshot joined with its explicitly separate ephemeral Turn
 * overlay and replaceable assistant preview. The Port keeps those update kinds
 * distinct; this view seam preserves that distinction while giving the Workbench
 * one lifecycle-owned subscription. */
export interface RunWorkbenchProjection {
  readonly snapshot: Accessor<RunSnapshot>;
  readonly live: Accessor<RunLiveOverlay | undefined>;
  readonly preview: Accessor<string | undefined>;
  readonly freshness: Accessor<TRunViewFreshness>;
  reconnect(): void;
}

export interface RunWorkbenchView {
  /** Opens the `run` Projection for one Run id; closes it on cleanup of the
   *  calling owner. Durable, live-overlay, and preview updates remain separate. */
  openRun(runId: string): RunWorkbenchProjection;
  /** Resolves one output or diagnostic reference to its bytes, or a Problem. */
  readResource(
    reference: ResourceReference | DiagnosticReference,
  ): ResourceRead;
  /** Resolves a transcript `page`/`export` reference (#124): a bounded ordered
   *  page (paged older through its cursor) or the complete export. */
  readTranscript(
    reference: TranscriptPageReference | TranscriptExportReference,
  ): TranscriptRead;
  /** Answers the Human Gate the blocked snapshot rests at, against its exact Gate
   *  reference (ADR 0020, #85): `continue` grants one more interval, `stop` ends
   *  the Run `failed`. The accessor starts `pending` and settles once the
   *  Operation outcome resolves; the open Run snapshot then follows the change. */
  answer(
    gate: RunGateReference,
    answer: "continue" | "stop",
  ): Accessor<AnswerOutcome>;
  /** Sends one human Turn to the interactive-agent Step the Run is blocked at (#122):
   *  the verbatim text becomes the Turn's transcript input. The accessor starts
   *  `pending` and settles once the Operation resolves; the open snapshot follows the
   *  new transcript in. */
  sendInteractiveTurn(
    runId: string,
    stepId: string,
    text: string,
  ): Accessor<AnswerOutcome>;
  /** Ends the interactive-agent Step the Run is blocked at (#122): settles the Step
   *  succeeded and advances the Run. Offered only at a Turn boundary. */
  endInteractiveStep(runId: string, stepId: string): Accessor<AnswerOutcome>;
  /** Continues a human-controlled Repeat (#217): settles the iteration's interactive
   *  Step and opens the next iteration in a fresh Session. Offered only at a Turn
   *  boundary, in place of End Step. */
  continueRepeat(runId: string, stepId: string): Accessor<AnswerOutcome>;
  /** Steers the live Turn with same-Turn guidance (#148): the verbatim text reaches
   *  the running agent without ending the Turn. Offered only when the prepared
   *  Harness declares native steer. The accessor starts `pending` and settles once
   *  the Operation resolves; a rejected or stale steer settles `refused`. */
  steer(runId: string, turnId: string, text: string): Accessor<AnswerOutcome>;
  /** Answers a free-text Human Gate (#108): publishes `text` as the gate's declared
   *  `text` output and advances the Run. The accessor starts `pending` and settles
   *  once the Operation resolves; a shape mismatch or stale Gate settles `refused`. */
  answerText(gate: RunGateReference, text: string): Accessor<AnswerOutcome>;
  /** Answers one outstanding approval Harness Request (#117) against the exact
   *  `requestId`/`generation` its Offer carried. A stale generation or an
   *  already-settled request settles `refused` (the Application decides, never the
   *  client); an applied answer lets the live Turn continue. `by` is `human`. */
  answerRequest(
    offer: AnswerHarnessRequestOffer,
    decision: ApprovalDecisionName,
  ): Accessor<AnswerOutcome>;
}

const ctx = createContext<RunWorkbenchView>();

export function RunWorkbenchViewProvider(
  props: ParentProps<{ view: RunWorkbenchView }>,
) {
  return <ctx.Provider value={props.view}>{props.children}</ctx.Provider>;
}

export function useRunWorkbenchView(): RunWorkbenchView {
  const value = useContext(ctx);
  if (!value)
    throw new Error(
      "useRunWorkbenchView must be used within a RunWorkbenchViewProvider",
    );
  return value;
}

/**
 * A live view over the Projection Port. `openRun` opens the `run` selector so the
 * overload fixes the snapshot type (#74 A8), seeds a signal, follows durable
 * updates so the timeline advances as Attempts settle, and closes on cleanup of
 * the calling reactive owner. The `closed` flag stops the loop the moment cleanup
 * runs so a late update can't set a signal after the owner is disposed.
 */
export function createLiveRunWorkbenchView(
  port: ProjectionPort,
): RunWorkbenchView {
  return {
    openRun: (runId) =>
      followRunProjection(() => port.openProjection({ family: "run", runId })),
    readResource: (reference) => port.readResource(reference),
    readTranscript: (reference) => port.readTranscript(reference),
    // The one Workbench write: the same submit-and-settle protocol headless `run
    // answer` runs (A23), minus the read-back — submit against the snapshot's Gate
    // and follow the Operation to settlement. A `continue` answer drives execution
    // asynchronously now, so this awaits the operation stream rather than reading an
    // inline outcome (#98). The open `run` snapshot already follows the Run leaving
    // `blocked`, so this seam never re-opens it.
    answer: (gate, answer) =>
      submitAndSettle(port, {
        operationId: randomUUID(),
        operation: "answer-human-gate",
        input: { runId: gate.runId, gate, answer },
      }),
    // Interactive turn-taking (#122): each write is the same submit-and-settle
    // protocol; the open `run` snapshot follows the Run's new transcript / advance.
    sendInteractiveTurn: (runId, stepId, text) =>
      submitAndSettle(port, {
        operationId: randomUUID(),
        operation: "send-interactive-turn",
        input: { runId, stepId, text },
      }),
    endInteractiveStep: (runId, stepId) =>
      submitAndSettle(port, {
        operationId: randomUUID(),
        operation: "end-interactive-step",
        input: { runId, stepId },
      }),
    continueRepeat: (runId, stepId) =>
      submitAndSettle(port, {
        operationId: randomUUID(),
        operation: "continue-repeat",
        input: { runId, stepId },
      }),
    // Same-Turn guidance (#148): Turn-scoped like an approval answer, so it must
    // reach the live Turn before it settles. The Application refuses an unavailable
    // Harness or a stale/rejected control as a value; an applied steer leaves the
    // Turn running, and the open snapshot keeps following it.
    steer: (runId, turnId, text) =>
      submitAndSettle(port, {
        operationId: randomUUID(),
        operation: "steer-turn",
        input: { runId, turnId, text },
      }),
    // A free-text gate answer publishes the text as the gate's declared output and
    // advances the Run in one Store boundary (#108); the open snapshot follows the
    // Run leaving `blocked`, so this seam never re-reads it.
    answerText: (gate, text) =>
      submitAndSettle(port, {
        operationId: randomUUID(),
        operation: "answer-human-gate",
        input: { runId: gate.runId, gate, text },
      }),
    // The live Turn request answer (#117): Turn-scoped, so it must reach the live
    // Turn before it settles. The Application refuses a stale generation as a value.
    answerRequest: (offer, decision) =>
      submitAndSettle(port, {
        operationId: randomUUID(),
        operation: "answer-harness-request",
        input: {
          runId: offer.runId,
          requestId: offer.requestId,
          generation: offer.generation,
          decision,
          by: "human",
        },
      }),
  };
}

/** Follow all three update lanes of an opened Run Projection. Preview-only
 * updates replace the current preview without changing the overlay generation;
 * a settling overlay is cleared once the durable `turn-settled` truth lands, so
 * replaceable text can never remain beside its authoritative content. */
function followRunProjection(
  open: () => OpenedProjection<RunSnapshot>,
): RunWorkbenchProjection {
  const followed = followProjectionUpdates<RunSnapshot, FollowedRun>({
    open,
    seed: (snapshot) => ({ snapshot }),
    reduce: reduceRunUpdate,
  });
  return {
    snapshot: () => followed.state().snapshot,
    live: () => followed.state().live,
    preview: () => followed.state().preview,
    freshness: followed.freshness,
    reconnect: followed.reconnect,
  };
}

interface FollowedRun {
  readonly snapshot: RunSnapshot;
  readonly live?: RunLiveOverlay;
  readonly preview?: string;
  readonly settledCountAtSettling?: number;
}

function reduceRunUpdate(
  state: FollowedRun,
  update: ProjectionUpdate<RunSnapshot>,
): FollowedRun {
  if (update.kind === "durable") {
    const settledCount = settledTurnCount(update.snapshot);
    const settled =
      state.live?.phase === "settling" &&
      state.settledCountAtSettling !== undefined &&
      settledCount > state.settledCountAtSettling;
    // Drop the live overlay and preview once the Turn's authoritative truth lands (the
    // settling watermark passed) or once durable liveness leaves live-here. A lost Turn
    // otherwise leaves the last overlay standing — a dead approval-request control over a
    // Run no longer live here, the header still claiming an ephemeral Harness Request (A8).
    if (settled || !isLiveHere(update.snapshot)) {
      return { snapshot: update.snapshot };
    }
    return { ...state, snapshot: update.snapshot };
  }
  if (update.kind === "live") {
    return {
      ...state,
      live: update.overlay,
      preview: update.overlay.preview,
      settledCountAtSettling:
        update.overlay.phase === "settling"
          ? settledTurnCount(state.snapshot)
          : undefined,
    };
  }
  if (update.kind === "preview") {
    return {
      ...state,
      preview: update.text.length > 0 ? update.text : undefined,
    };
  }
  // A `closed` update ends the follow (observer lagged, subject gone, shutdown) with
  // the last live overlay still in state; clear it and the preview so a lost Turn
  // leaves no dead request control up (A8).
  if (update.kind === "closed") {
    return { snapshot: state.snapshot };
  }
  return state;
}

/** Whether the durable snapshot reports the Run live in this instance. The live
 *  overlay is this instance's ephemeral Turn view, so it can only stand while the
 *  Run is live-here (A8). */
function isLiveHere(snapshot: RunSnapshot): boolean {
  return (
    snapshot.result.found && snapshot.result.run.liveness.state === "live-here"
  );
}

function settledTurnCount(snapshot: RunSnapshot): number {
  return snapshot.result.found
    ? snapshot.result.run.timeline.filter(
        (event) => event.event === "turn-settled",
      ).length
    : 0;
}
