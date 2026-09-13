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
// workspace-view.tsx's submit seam: it reproduces headless `launchRun`
// (headless.ts) — submit `launch-run`, read the settled Operation outcome, then
// open the created Run for its id and state — behind one `launch` call that
// returns a reactive outcome. Built over the Projection Port for production and
// hand-driven with a fake in renderer tests, so the same screens serve both. It
// is the first TUI write path beyond `approve-workspace`, and the only seam that
// opens the `operation` and `run` families.

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
 * A live launch seam over the Projection Port. It runs the exact sequence the
 * headless client does: submit, surface a not-admitted Problem, read the settled
 * Operation outcome (settlement is inline in the Application by default, so the
 * outcome is already `applied`/`not-applied` here), and open the created Run for
 * its id and state. Every refusal in that sequence resolves to `refused`.
 *
 * ponytail: no updates-loop for a deferred outcome — production settles inline so
 * the accessor resolves before the first read; the `pending` state is exercised by
 * the renderer test's fake seam. Add the loop only if the Application ever defers
 * launch settlement outside tests.
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
      const operation = port.openProjection({
        family: "operation",
        operationId: admission.operationId,
      });
      const settled = operation.snapshot.outcome;
      operation.close();
      // Only an `applied` outcome opens the Run. `not-applied` carries its
      // Problem; a still-`pending` outcome would mean settlement was deferred (it
      // is not, in production), and reading the Run then would be premature — so
      // refuse it explicitly rather than fall through to a misleading receipt.
      if (settled.status !== "applied") {
        setOutcome({
          kind: "refused",
          problem:
            settled.status === "not-applied"
              ? settled.problem
              : launchNotSettled(),
        });
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

function launchNotSettled(): Problem {
  return {
    code: "launch-not-settled",
    explanation: "The launch had not settled when its outcome was read.",
    remediation: "Retry the launch; if it persists, report it.",
    possibleEffects: "unknown",
  };
}
