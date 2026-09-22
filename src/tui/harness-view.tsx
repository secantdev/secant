import {
  createContext,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type {
  HarnessCatalogSnapshot,
  HarnessFocusSelector,
  HarnessFocusSnapshot,
  ProjectionPort,
} from "../application/projection-port.js";
import { followProjection } from "./follow.js";

// The view-state the Harness step (and, later, the Harness catalog screen) reads,
// mirroring bundle-view.tsx: `openList` opens the spawn-free `harness-catalog` list
// Projection; `openFocus` opens one Harness's focus, which triggers bounded
// qualification for exactly that Harness (ADR 0022, #188). Built over the Projection
// Port for production and hand-driven with fake snapshots in renderer tests, so the
// same components serve both. Read-only: this family offers no Actions, so no submit.

export interface HarnessCatalogView {
  /** Opens the list Projection; closes it on cleanup of the calling owner. A list
   *  open performs discovery only and spawns nothing (#191). */
  openList(): Accessor<HarnessCatalogSnapshot>;
  /** Opens one Harness's focus Projection, qualifying only that Harness; closes it
   *  on cleanup. */
  openFocus(selector: HarnessFocusSelector): Accessor<HarnessFocusSnapshot>;
}

const ctx = createContext<HarnessCatalogView>();

export function HarnessCatalogViewProvider(
  props: ParentProps<{ view: HarnessCatalogView }>,
) {
  return <ctx.Provider value={props.view}>{props.children}</ctx.Provider>;
}

export function useHarnessCatalogView(): HarnessCatalogView {
  const value = useContext(ctx);
  if (!value)
    throw new Error(
      "useHarnessCatalogView must be used within a HarnessCatalogViewProvider",
    );
  return value;
}

/**
 * A live view over the Projection Port, following the bundle-catalog seam: each
 * `open*` opens its Projection, seeds a signal from the snapshot, follows durable
 * updates (so a focus's qualification result refreshes the screen), and closes on
 * cleanup of the calling reactive owner. Call `openList`/`openFocus` inside a
 * component.
 */
export function createLiveHarnessCatalogView(
  port: ProjectionPort,
): HarnessCatalogView {
  return {
    openList: () =>
      followProjection(() =>
        port.openProjection({ family: "harness-catalog" }),
      ),
    openFocus: (selector) =>
      followProjection(() =>
        port.openProjection({ family: "harness-catalog", focus: selector }),
      ),
  };
}
