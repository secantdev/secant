import {
  createContext,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSelector,
  BundleFocusSnapshot,
  OpenedProjection,
  ProjectionPort,
  ProjectionSnapshot,
} from "../application/projection-port.js";

// The view-state the Bundle screens render, mirroring workspace-view.tsx: each
// screen opens exactly one `bundle-catalog` Projection (the list, or one focus)
// as a reactive accessor and follows its durable updates. Built over the
// Projection Port for production and hand-driven with fake snapshots in renderer
// tests, so the same components serve both. Read-only: this family offers no
// Actions, so there is no submit here.

export interface BundleCatalogView {
  /** Opens the list Projection; closes it on cleanup of the calling owner. */
  openList(): Accessor<BundleCatalogSnapshot>;
  /** Opens one Bundle's focus Projection; closes it on cleanup. */
  openFocus(selector: BundleFocusSelector): Accessor<BundleFocusSnapshot>;
}

const ctx = createContext<BundleCatalogView>();

export function BundleCatalogViewProvider(
  props: ParentProps<{ view: BundleCatalogView }>,
) {
  return <ctx.Provider value={props.view}>{props.children}</ctx.Provider>;
}

export function useBundleCatalogView(): BundleCatalogView {
  const value = useContext(ctx);
  if (!value)
    throw new Error(
      "useBundleCatalogView must be used within a BundleCatalogViewProvider",
    );
  return value;
}

/**
 * A live view over the Projection Port. Each `open*` opens its Projection,
 * seeds a signal from the snapshot, follows durable updates so a concurrent
 * install refreshes the screen, and closes on cleanup of the calling reactive
 * owner. Call `openList`/`openFocus` inside a component.
 */
export function createLiveBundleCatalogView(
  port: ProjectionPort,
): BundleCatalogView {
  // One subscription block for both screens: seed a signal from the opened
  // Projection's snapshot, follow durable updates, and close on cleanup. The
  // Projection is opened by the caller so `openProjection`'s selector-typed
  // overload fixes `S`, and the snapshot and each update read at that type with
  // no cast (#74 A8). The `closed` flag stops the loop the moment cleanup runs so
  // a late update can't set a signal after the owner is disposed.
  function open<S extends ProjectionSnapshot>(
    opened: OpenedProjection<S>,
  ): Accessor<S> {
    const [snapshot, setSnapshot] = createSignal(opened.snapshot);
    let closed = false;
    void (async () => {
      for await (const update of opened.updates) {
        if (closed) break;
        if (update.kind === "durable") setSnapshot(() => update.snapshot);
      }
    })();
    onCleanup(() => {
      closed = true;
      opened.close();
    });
    return snapshot;
  }

  return {
    openList: () => open(port.openProjection({ family: "bundle-catalog" })),
    openFocus: (selector) =>
      open(port.openProjection({ family: "bundle-catalog", focus: selector })),
  };
}
