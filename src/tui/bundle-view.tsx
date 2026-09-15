import {
  createContext,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSelector,
  BundleFocusSnapshot,
  ProjectionPort,
} from "../application/projection-port.js";
import { followProjection } from "./follow.js";

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
  // Both screens follow their opened Projection through the shared follow-snapshot
  // helper (A22): a concurrent install refreshes the screen. The Projection is
  // opened by the caller so its selector-typed overload fixes the snapshot type.
  return {
    openList: () =>
      followProjection(port.openProjection({ family: "bundle-catalog" })),
    openFocus: (selector) =>
      followProjection(
        port.openProjection({ family: "bundle-catalog", focus: selector }),
      ),
  };
}
