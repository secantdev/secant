import { createSignal, onCleanup, type Accessor } from "solid-js";
import type {
  OpenedProjection,
  ProjectionSnapshot,
  ProjectionUpdate,
} from "../application/projection-port.js";

// The one follow-snapshot helper the per-screen view seams share (A22): seed a
// signal from an opened Projection's snapshot, follow its durable updates on the
// live edge, and close it on cleanup of the calling reactive owner. The
// `bundle-catalog`, `workspace`, and `run` read seams were three byte-equivalent
// copies of this loop; this is their single owner.

/**
 * Follow an opened Projection as a reactive accessor. The Projection is opened by
 * the caller so `openProjection`'s selector-typed overload fixes `S`, and the
 * snapshot and each durable update read at that exact type with no cast (#74 A8).
 * The `closed` flag stops the loop the instant cleanup runs, so a late update can
 * never set a signal after the owner is disposed. A `closed` update (observer
 * lagged, subject gone, …) ends the follow; the last snapshot stays — re-open on
 * loss is a later slice, not M2. Call inside a reactive owner (a component or a
 * `createMemo`), since it registers `onCleanup`.
 */
export function followProjection<S extends ProjectionSnapshot>(
  opened: OpenedProjection<S>,
): Accessor<S> {
  return followProjectionUpdates(opened, opened.snapshot, (snapshot, update) =>
    update.kind === "durable" ? update.snapshot : snapshot,
  );
}

/** Follow one Projection update stream while a caller-owned reducer decides how
 * every update lane changes its reactive state. Iteration, disposal ordering,
 * late-update suppression, and closing remain centralized here; specialized
 * views own only their semantic reduction. */
export function followProjectionUpdates<S extends ProjectionSnapshot, State>(
  opened: OpenedProjection<S>,
  initial: State,
  reduce: (state: State, update: ProjectionUpdate<S>) => State,
): Accessor<State> {
  const [state, setState] = createSignal<State>(initial);
  let closed = false;
  void (async () => {
    for await (const update of opened.updates) {
      if (closed) break;
      setState((current) => reduce(current, update));
    }
  })();
  onCleanup(() => {
    closed = true;
    opened.close();
  });
  return state;
}
