import { randomUUID } from "node:crypto";
import {
  createContext,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type {
  InterruptTurnOffer,
  Problem,
  ProjectionPort,
  ResumeRunOffer,
} from "../application/projection-port.js";
import { submitAndSettle } from "./submit-and-settle.js";

// The submit seam the Run Workbench's Run Actions dispatch through (#92),
// mirroring workspace-view.tsx's `approve` and headless `endRunOperation` /
// `resumeRun` (headless.ts): submit the Operation and follow it to settlement,
// reporting ok or the refusal Problem. Distinct from the `run` read seam
// (run-view.tsx), which is read-only — Run Actions are writes, so they need their
// own seam. Built over the Projection Port for production and hand-driven with a
// fake in renderer tests, so the same Workbench serves both.
//
// Each action returns a reactive outcome that starts `pending` and settles once
// the Operation resolves: resume drives execution and a cancel-as-abort aborts a
// live Run, both asynchronous now (#98), so the seam follows the operation stream
// rather than reading an inline outcome. The Run's resulting state (a resumed Run
// advancing, a cancelled Run resting) reaches the Workbench through the `run` read
// seam's durable updates, exactly as headless re-reads the Run after settlement.

/** A dispatched Run Action as the Workbench observes it: `pending` until it
 *  settles, then applied (`ok`), or refused with the reason (an Offer is present
 *  only while the Action is legal, so a race that made it illegal is reported as
 *  the refusal rather than guessed at up front). */
export type RunActionOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly problem: Problem };

export interface RunActionsView {
  /** Resume a resting Run or perform the takeover named by its current Offer. */
  resume(offer: ResumeRunOffer): Accessor<RunActionOutcome>;
  /** Cancel a live Run: ends it `cancelled`, keeping history (#87). */
  cancel(runId: string): Accessor<RunActionOutcome>;
  /** Delete a resting or terminal Run: removes its store from disk (#87). */
  remove(runId: string): Accessor<RunActionOutcome>;
  /** Interrupt the live Turn its Offer names (#118): stops the Turn, ends the
   *  Attempt `cancelled`, and rests the Run `halted` (resumable). The Offer carries
   *  the live `turnId`, so a control that named a settled Turn is refused. */
  interrupt(offer: InterruptTurnOffer): Accessor<RunActionOutcome>;
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
 * A live Run Actions seam over the Projection Port. Each action submits its
 * Operation through the shared submit-and-settle helper (A23) and maps the settled
 * outcome to this seam's shape: `applied` is `ok`, anything else is the refusal.
 * All three Operations key on the Run id alone.
 */
export function createLiveRunActionsView(port: ProjectionPort): RunActionsView {
  const end = (
    operation: "resume-run" | "cancel-run" | "delete-run",
    runId: string,
  ): Accessor<RunActionOutcome> => {
    const settle = submitAndSettle(port, {
      operationId: randomUUID(),
      operation,
      input: { runId },
    });
    return () => {
      const outcome = settle();
      return outcome.kind === "applied" ? { kind: "ok" } : outcome;
    };
  };
  return {
    resume: (offer) => {
      const settle = submitAndSettle(port, {
        operationId: randomUUID(),
        operation: "resume-run",
        input: {
          runId: offer.runId,
          ...(offer.takeover !== undefined ? { takeover: offer.takeover } : {}),
        },
      });
      return () => {
        const outcome = settle();
        return outcome.kind === "applied" ? { kind: "ok" } : outcome;
      };
    },
    cancel: (runId) => end("cancel-run", runId),
    remove: (runId) => end("delete-run", runId),
    interrupt: (offer) => {
      const settle = submitAndSettle(port, {
        operationId: randomUUID(),
        operation: "interrupt-turn",
        input: { runId: offer.runId, turnId: offer.turnId },
      });
      return () => {
        const outcome = settle();
        return outcome.kind === "applied" ? { kind: "ok" } : outcome;
      };
    },
  };
}
