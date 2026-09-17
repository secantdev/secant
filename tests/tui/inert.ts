import type { RunActionsView, RunListView } from "../../src/tui/tui.js";

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
