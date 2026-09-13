import { randomUUID } from "node:crypto";
import { createContext, useContext, type ParentProps } from "solid-js";
import type {
  Problem,
  ProjectionPort,
} from "../application/projection-port.js";

// The submit seam the Run Workbench's Run Actions dispatch through (#92),
// mirroring workspace-view.tsx's `approve` and headless `endRunOperation` /
// `resumeRun` (headless.ts): submit the Operation, read its settled outcome, and
// report ok or the refusal Problem. Distinct from the `run` read seam
// (run-view.tsx), which is read-only — Run Actions are writes, so they need their
// own seam. Built over the Projection Port for production and hand-driven with a
// fake in renderer tests, so the same Workbench serves both.
//
// It reports only whether the Operation was admitted and applied; the Run's
// resulting state (a resumed Run advancing, a cancelled Run resting) reaches the
// Workbench through the `run` read seam's durable updates, exactly as headless
// re-reads the Run after the Operation settles.

/** A dispatched Run Action as the Workbench observes it: applied, or refused with
 *  the reason (the "unavailable reason when relevant" surfaces here, on refusal —
 *  an Offer is present only while the Action is legal, so a race that made it
 *  illegal is reported as the refusal rather than guessed at up front). */
export type RunActionOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly problem: Problem };

export interface RunActionsView {
  /** Resume a resting Run (halted/failed): drives it to its next rest (#86). */
  resume(runId: string): RunActionOutcome;
  /** Cancel a live Run: ends it `cancelled`, keeping history (#87). */
  cancel(runId: string): RunActionOutcome;
  /** Delete a resting or terminal Run: removes its store from disk (#87). */
  remove(runId: string): RunActionOutcome;
}

const ctx = createContext<RunActionsView>();

export function RunActionsViewProvider(
  props: ParentProps<{ view: RunActionsView }>,
) {
  return <ctx.Provider value={props.view}>{props.children}</ctx.Provider>;
}

export function useRunActionsView(): RunActionsView {
  const value = useContext(ctx);
  if (!value)
    throw new Error(
      "useRunActionsView must be used within a RunActionsViewProvider",
    );
  return value;
}

/**
 * A live Run Actions seam over the Projection Port. Each action runs the exact
 * sequence the headless client does: submit the Operation, surface a not-admitted
 * Problem, then read the settled Operation outcome (settlement is inline in the
 * Application by default, so the outcome is already applied/not-applied here) and
 * surface a not-applied Problem. All three Operations key on the Run id alone.
 */
export function createLiveRunActionsView(port: ProjectionPort): RunActionsView {
  const end = (
    operation: "resume-run" | "cancel-run" | "delete-run",
    runId: string,
  ): RunActionOutcome => {
    const admission = port.submit({
      operationId: randomUUID(),
      operation,
      input: { runId },
    });
    if (!admission.admitted)
      return { kind: "refused", problem: admission.problem };
    const opened = port.openProjection({
      family: "operation",
      operationId: admission.operationId,
    });
    const outcome = opened.snapshot.outcome;
    opened.close();
    // Only an `applied` outcome is success. Settlement is inline in production, so
    // a still-`pending` outcome would mean settlement was deferred (it is not);
    // reading it as `ok` would navigate away (delete) or clear the control on a
    // Run that was never acted on — so refuse it, like the launch/answer seams.
    if (outcome.status === "applied") return { kind: "ok" };
    return {
      kind: "refused",
      problem:
        outcome.status === "not-applied"
          ? outcome.problem
          : actionNotSettled(operation),
    };
  };
  return {
    resume: (runId) => end("resume-run", runId),
    cancel: (runId) => end("cancel-run", runId),
    remove: (runId) => end("delete-run", runId),
  };
}

function actionNotSettled(
  operation: "resume-run" | "cancel-run" | "delete-run",
): Problem {
  return {
    code: "run-action-not-settled",
    explanation: `The ${operation} had not settled when its outcome was read.`,
    remediation: "Retry the action; if it persists, report it.",
    possibleEffects: "unknown",
  };
}
