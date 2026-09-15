import { randomUUID } from "node:crypto";
import {
  createContext,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type {
  LaunchRunInput,
  Problem,
  ProjectionPort,
} from "../application/projection-port.js";

// The view-state the Start-a-Run flow submits through, mirroring
// workspace-view.tsx's submit seam: submit `launch-run` and resolve at admission —
// the Run id is known and the Run is observable `running` from the moment it is
// admitted (#98 A7), so the flow transitions into the Workbench before the Run
// rests and the Workbench follows the live `run` Projection to settlement (S1).
// Built over the Projection Port for production and hand-driven with a fake in
// renderer tests, so the same screens serve both. Unlike answer/resume/cancel/
// delete this seam never awaits the operation outcome — a launch that Preflight or
// Trust refuses surfaces as a not-admitted admission, before any Run exists.

/** The launch as the flow observes it: `pending` until it settles, then either a
 *  receipt (the created Run's id and state) or a refusal Problem. */
export type LaunchOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "refused"; readonly problem: Problem }
  | {
      readonly kind: "launched";
      readonly runId: string;
      readonly state: string;
    };

export interface RunLaunchView {
  /** Submit `launch-run` and follow it to a receipt or a refusal. The accessor
   *  starts `pending` and settles once the Operation outcome and the created Run
   *  resolve. */
  launch(input: LaunchRunInput): Accessor<LaunchOutcome>;
}

const ctx = createContext<RunLaunchView>();

export function RunLaunchViewProvider(
  props: ParentProps<{ view: RunLaunchView }>,
) {
  return <ctx.Provider value={props.view}>{props.children}</ctx.Provider>;
}

export function useRunLaunchView(): RunLaunchView {
  const value = useContext(ctx);
  if (!value)
    throw new Error(
      "useRunLaunchView must be used within a RunLaunchViewProvider",
    );
  return value;
}

/**
 * A live launch seam over the Projection Port. It submits `launch-run`, surfaces a
 * not-admitted Problem (a Preflight or Trust refusal, carrying field violations for
 * an inputs-screen fault), and otherwise resolves `launched` at admission: the Run
 * id is known and the Run is observable at once, so it reads the created Run's
 * snapshot once for the initial state to build the receipt and returns. The
 * Workbench then follows the live `run` Projection as execution runs and settles;
 * this seam does not await the operation outcome (S1).
 */
export function createLiveRunLaunchView(port: ProjectionPort): RunLaunchView {
  return {
    launch(input) {
      const [outcome, setOutcome] = createSignal<LaunchOutcome>({
        kind: "pending",
      });
      const admission = port.submit({
        operationId: randomUUID(),
        operation: "launch-run",
        input,
      });
      if (!admission.admitted) {
        setOutcome({ kind: "refused", problem: admission.problem });
        return outcome;
      }
      const runId = admission.runId;
      if (runId === undefined) {
        // A launch always identifies its Run; a missing id is a contract breach.
        setOutcome({ kind: "refused", problem: runNotIdentified() });
        return outcome;
      }
      const run = port.openProjection({ family: "run", runId });
      const result = run.snapshot.result;
      run.close();
      setOutcome(
        result.found
          ? { kind: "launched", runId, state: result.run.state }
          : { kind: "refused", problem: result.problem },
      );
      return outcome;
    },
  };
}

function runNotIdentified(): Problem {
  return {
    code: "run-not-identified",
    explanation: "The launch was admitted without identifying a Run.",
    remediation: "Retry the launch; if it persists, report it.",
    possibleEffects: "unknown",
  };
}
