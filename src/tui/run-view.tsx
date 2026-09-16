import { randomUUID } from "node:crypto";
import {
  createContext,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type {
  DiagnosticReference,
  OpenedProjection,
  ProjectionPort,
  ResourceRead,
  ResourceReference,
  RunLiveOverlay,
  RunGateReference,
  RunSnapshot,
} from "../application/projection-port.js";
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

/** The durable Run snapshot joined with its explicitly separate ephemeral Turn
 * overlay and replaceable assistant preview. The Port keeps those update kinds
 * distinct; this view seam preserves that distinction while giving the Workbench
 * one lifecycle-owned subscription. */
export interface RunWorkbenchProjection {
  readonly snapshot: Accessor<RunSnapshot>;
  readonly live: Accessor<RunLiveOverlay | undefined>;
  readonly preview: Accessor<string | undefined>;
}

export interface RunWorkbenchView {
  /** Opens the `run` Projection for one Run id; closes it on cleanup of the
   *  calling owner. Durable, live-overlay, and preview updates remain separate. */
  openRun(runId: string): RunWorkbenchProjection;
  /** Resolves one output or diagnostic reference to its bytes, or a Problem. */
  readResource(
    reference: ResourceReference | DiagnosticReference,
  ): ResourceRead;
  /** Answers the Human Gate the blocked snapshot rests at, against its exact Gate
   *  reference (ADR 0020, #85): `continue` grants one more interval, `stop` ends
   *  the Run `failed`. The accessor starts `pending` and settles once the
   *  Operation outcome resolves; the open Run snapshot then follows the change. */
  answer(
    gate: RunGateReference,
    answer: "continue" | "stop",
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
      followRunProjection(port.openProjection({ family: "run", runId })),
    readResource: (reference) => port.readResource(reference),
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
  };
}

/** Follow all three update lanes of an opened Run Projection. Preview-only
 * updates replace the current preview without changing the overlay generation;
 * a settling overlay is cleared once the durable `turn-settled` truth lands, so
 * replaceable text can never remain beside its authoritative content. */
function followRunProjection(
  opened: OpenedProjection<RunSnapshot>,
): RunWorkbenchProjection {
  const [snapshot, setSnapshot] = createSignal(opened.snapshot);
  const [live, setLive] = createSignal<RunLiveOverlay>();
  const [preview, setPreview] = createSignal<string>();
  let closed = false;
  let settledCountAtSettling: number | undefined;
  void (async () => {
    for await (const update of opened.updates) {
      if (closed) break;
      if (update.kind === "durable") {
        setSnapshot(() => update.snapshot);
        const settledCount = settledTurnCount(update.snapshot);
        if (
          live()?.phase === "settling" &&
          settledCountAtSettling !== undefined &&
          settledCount > settledCountAtSettling
        ) {
          setLive(undefined);
          setPreview(undefined);
          settledCountAtSettling = undefined;
        }
      } else if (update.kind === "live") {
        setLive(update.overlay);
        setPreview(update.overlay.preview);
        settledCountAtSettling =
          update.overlay.phase === "settling"
            ? settledTurnCount(snapshot())
            : undefined;
      } else if (update.kind === "preview") {
        setPreview(update.text.length > 0 ? update.text : undefined);
      }
    }
  })();
  onCleanup(() => {
    closed = true;
    opened.close();
  });
  return { snapshot, live, preview };
}

function settledTurnCount(snapshot: RunSnapshot): number {
  return snapshot.result.found
    ? snapshot.result.run.timeline.filter(
        (event) => event.event === "turn-settled",
      ).length
    : 0;
}
