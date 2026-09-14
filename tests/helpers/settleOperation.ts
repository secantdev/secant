import type {
  OperationOutcome,
  ProjectionPort,
} from "../../src/application/projection-port.js";

/** Await a submitted Operation's settled outcome. A Run Operation (launch-run,
 *  resume-run, answer-human-gate) settles asynchronously now — execution spawns —
 *  so the outcome is `pending` right after `submit` and arrives as the operation
 *  stream's first durable update (no sleep, no poll). A synchronous Operation is
 *  already settled and returns at once. Shared by every suite that drives a Run
 *  through the Projection Port and then reads the settled result. */
export async function awaitSettled(
  port: ProjectionPort,
  operationId: string,
): Promise<OperationOutcome> {
  const view = port.openProjection({ family: "operation", operationId });
  try {
    if (view.snapshot.outcome.status !== "pending")
      return view.snapshot.outcome;
    for await (const update of view.updates) {
      if (
        update.kind === "durable" &&
        update.snapshot.outcome.status !== "pending"
      ) {
        return update.snapshot.outcome;
      }
    }
    return view.snapshot.outcome;
  } finally {
    view.close();
  }
}
