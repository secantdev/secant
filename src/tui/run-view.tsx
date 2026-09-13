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
  ProjectionPort,
  ResourceRead,
  ResourceReference,
  RunSnapshot,
} from "../application/projection-port.js";

// The view-state the Run Workbench renders, mirroring bundle-view.tsx: it opens
// the existing `run` Projection as a *reactive* accessor and follows its durable
// updates on the live edge (each Attempt publication commits a fresh snapshot),
// so the Workbench watches a Run change without ceremony. Distinct from the
// launch seam (run-launch-view.tsx), which reads the Run once to build a receipt.
// It also resolves a `text`/`verdict`/diagnostic Resource Reference on demand, so
// large output is fetched only when the user opens it and never inlined into the
// snapshot (#91 AC4). Built over the Projection Port for production and
// hand-driven with fake `run` snapshots in renderer tests, so the same screens
// serve both. Read-only navigation: Run Actions land in #92.

export interface RunWorkbenchView {
  /** Opens the `run` Projection for one Run id; closes it on cleanup of the
   *  calling owner. The accessor tracks durable updates on the live edge. */
  openRun(runId: string): Accessor<RunSnapshot>;
  /** Resolves one output or diagnostic reference to its bytes, or a Problem. */
  readResource(
    reference: ResourceReference | DiagnosticReference,
  ): ResourceRead;
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
    openRun(runId) {
      const opened = port.openProjection({ family: "run", runId });
      const [snapshot, setSnapshot] = createSignal(opened.snapshot);
      let closed = false;
      void (async () => {
        for await (const update of opened.updates) {
          if (closed) break;
          // A `closed` update (observer-lagged, subject-gone, …) ends the follow;
          // the Workbench keeps the last snapshot rather than re-opening. Matches
          // workspace-view/bundle-view — re-open on loss is a later slice, not M2.
          if (update.kind === "durable") setSnapshot(() => update.snapshot);
        }
      })();
      onCleanup(() => {
        closed = true;
        opened.close();
      });
      return snapshot;
    },
    readResource: (reference) => port.readResource(reference),
  };
}
