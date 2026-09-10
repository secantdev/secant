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
  ProjectionPort,
  WorkspaceSnapshot,
} from "../application/projection-port.js";

// The view-state the shell renders: the current `workspace` snapshot as a
// reactive accessor, plus `approve` which submits the `approve-workspace`
// Operation. Built over the Projection Port for production and hand-driven with
// fake snapshots in renderer tests, so the same components serve both.

export interface WorkspaceView {
  readonly snapshot: Accessor<WorkspaceSnapshot>;
  approve(): void;
}

const ctx = createContext<WorkspaceView>();

export function WorkspaceViewProvider(
  props: ParentProps<{ view: WorkspaceView }>,
) {
  return <ctx.Provider value={props.view}>{props.children}</ctx.Provider>;
}

export function useWorkspaceView(): WorkspaceView {
  const value = useContext(ctx);
  if (!value)
    throw new Error(
      "useWorkspaceView must be used within a WorkspaceViewProvider",
    );
  return value;
}

/**
 * A live view over the Projection Port: opens the one `workspace` Projection,
 * seeds a signal from its snapshot, and follows durable updates so approval
 * flips the screen from the dialog to Home. Call inside a reactive owner.
 */
export function createLiveWorkspaceView(port: ProjectionPort): WorkspaceView {
  const opened = port.openProjection({ family: "workspace" });
  const [snapshot, setSnapshot] = createSignal(
    opened.snapshot as WorkspaceSnapshot,
  );

  let closed = false;
  void (async () => {
    for await (const update of opened.updates) {
      if (closed) break;
      if (update.kind === "durable") {
        setSnapshot(update.snapshot as WorkspaceSnapshot);
      }
    }
  })();

  onCleanup(() => {
    closed = true;
    opened.close();
  });

  return {
    snapshot,
    approve() {
      port.submit({
        operationId: randomUUID(),
        operation: "approve-workspace",
        input: { path: snapshot().path },
      });
    },
  };
}
