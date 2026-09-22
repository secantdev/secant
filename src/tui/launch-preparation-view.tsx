import {
  createContext,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type {
  LaunchPreparationSnapshot,
  LaunchRunInput,
  ProjectionPort,
} from "../application/projection-port.js";
import { followProjection } from "./follow.js";

// The Start-a-Run Review step reads one live assessment for its complete draft.
// Submission remains owned by the separate run-launch seam.

export interface LaunchPreparationView {
  open(draft: LaunchRunInput): Accessor<LaunchPreparationSnapshot>;
}

const ctx = createContext<LaunchPreparationView>();

export function LaunchPreparationViewProvider(
  props: ParentProps<{ view: LaunchPreparationView }>,
) {
  return <ctx.Provider value={props.view}>{props.children}</ctx.Provider>;
}

export function useLaunchPreparationView(): LaunchPreparationView {
  const value = useContext(ctx);
  if (!value) {
    throw new Error(
      "useLaunchPreparationView must be used within a LaunchPreparationViewProvider",
    );
  }
  return value;
}

export function createLiveLaunchPreparationView(
  port: ProjectionPort,
): LaunchPreparationView {
  return {
    open: (draft) =>
      followProjection(() =>
        port.openProjection({ family: "launch-preparation", draft }),
      ),
  };
}
