import { createSignal } from "solid-js";
import type {
  HarnessCatalogView,
  RunActionsView,
  RunListView,
} from "../../src/tui/tui.js";
import type {
  HarnessCatalogSnapshot,
  HarnessFocusSelector,
  HarnessFocusSnapshot,
} from "../../src/application/projection-port.js";

// Inert seams for the App screens a given render never opens (A28): an empty
// Previous Runs list and a Run Actions seam that refuses. A test that actually
// reaches those screens wires a real fake instead; these keep the two now-required
// App props satisfied without pulling in behavior the test does not exercise.

export function inertRunListView(): RunListView {
  return {
    openRunList: () => ({
      state: () => ({
        rows: [],
        filter: "all",
        beginningOfHistory: true,
        hasMore: false,
      }),
      setResumable() {},
      loadMore() {},
    }),
  };
}

// An empty Harness catalog for the App screens a given render never reaches: the
// list is empty and any focus is a not-found refusal, so a stray Harness step is
// caught rather than silently served. A test that reaches the Harness step wires a
// real fake instead.
export function inertHarnessCatalogView(): HarnessCatalogView {
  const [list] = createSignal<HarnessCatalogSnapshot>({
    family: "harness-catalog",
    view: "list",
    harnesses: [],
  });
  return {
    openList: () => list,
    openFocus: (selector: HarnessFocusSelector) => {
      const [snapshot] = createSignal<HarnessFocusSnapshot>({
        family: "harness-catalog",
        view: "focus",
        selection: selector,
        result: {
          found: false,
          problem: {
            code: "harness-not-registered",
            explanation: "No Harness is wired in this context.",
            remediation: "Open a Bundle that needs a Harness.",
            possibleEffects: "none",
          },
        },
      });
      return snapshot;
    },
  };
}

export function inertRunActionsView(): RunActionsView {
  const refusal = {
    kind: "refused",
    problem: {
      code: "run-actions-unavailable",
      explanation: "Run Actions are not wired in this context.",
      remediation: "Open the Run from Previous Runs.",
      possibleEffects: "none",
    },
  } as const;
  // Each method takes a runId and returns an accessor of the outcome.
  return {
    resume: () => () => refusal,
    cancel: () => () => refusal,
    remove: () => () => refusal,
    interrupt: () => () => refusal,
  };
}
