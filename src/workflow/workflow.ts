// The Workflow Module owns Secant's execution-free authored vocabulary: the
// closed sets and grammars a Bundle manifest is written against. It executes
// nothing and imports no Node mechanism (the boundary suite enforces both), so
// the Bundle validator and, next slice, the Composition check can consult one
// authority for what a manifest may legally say. Step *execution* is a private
// table added beside this in M2; only the static contract lives here.

/** The five closed Run Artifact types. */
export type ArtifactType = "text" | "file" | "file-set" | "verdict" | "choice";
export const ARTIFACT_TYPES: readonly ArtifactType[] = [
  "text",
  "file",
  "file-set",
  "verdict",
  "choice",
];

/** Where a produced artifact lives; `workspace` requests a materialization. */
export type ArtifactHome = "store" | "workspace";
export const ARTIFACT_HOMES: readonly ArtifactHome[] = ["store", "workspace"];

/** The four Crucible-owned Step kinds. Secant owns the set; a Bundle supplies
 *  only content, parameters, and optional Workspace prerequisites. */
export type StepKindName =
  "agent" | "interactive-agent" | "human-gate" | "command";
export const STEP_KIND_NAMES: readonly StepKindName[] = [
  "agent",
  "interactive-agent",
  "human-gate",
  "command",
];

/** The two shapes a Human Gate carries. */
export type HumanGateShape = "approve-reject" | "free-text";
export const HUMAN_GATE_SHAPES: readonly HumanGateShape[] = [
  "approve-reject",
  "free-text",
];

/** How a Step Attempt may end. */
export type AttemptOutcome =
  "succeeded" | "failed" | "indeterminate" | "cancelled";

/** How a Step kind relates to a Harness Session. */
export type SessionNeed = "none" | "named";

/**
 * One Step kind's uniform contract, stated as the same seven facts for every
 * kind (#13). The orchestrator learns nothing per kind; adding a kind means
 * stating these facts, never branching on identity. `authored` marks a fact the
 * Bundle supplies per Step rather than one fixed by the kind.
 */
export interface StepKindContract {
  readonly kind: StepKindName;
  /** Artifacts required before the Step runs. */
  readonly requires: "authored";
  /** Artifacts produced. `authored` for agents; fixed for Command and Gates. */
  readonly produces: "authored" | readonly ArtifactType[] | "none";
  readonly session: SessionNeed;
  /** World facts checked at preflight beyond authored Workspace prerequisites. */
  readonly preconditions: "none" | "executable-on-path";
  readonly capabilityNeeds: readonly string[];
  readonly retryableOutcomes: readonly AttemptOutcome[];
  readonly reconciliation: "human-resume" | "reconciliation-probe";
}

export const STEP_KINDS: Readonly<Record<StepKindName, StepKindContract>> = {
  agent: {
    kind: "agent",
    requires: "authored",
    produces: "authored",
    session: "named",
    preconditions: "none",
    capabilityNeeds: ["agent-turn"],
    retryableOutcomes: ["failed"],
    reconciliation: "reconciliation-probe",
  },
  "interactive-agent": {
    kind: "interactive-agent",
    requires: "authored",
    produces: "authored",
    session: "named",
    preconditions: "none",
    capabilityNeeds: ["interactive-turns"],
    retryableOutcomes: ["failed"],
    reconciliation: "human-resume",
  },
  "human-gate": {
    kind: "human-gate",
    requires: "authored",
    // approve-reject produces nothing; free-text produces a text answer.
    produces: "authored",
    session: "none",
    preconditions: "none",
    capabilityNeeds: [],
    retryableOutcomes: [],
    reconciliation: "human-resume",
  },
  command: {
    kind: "command",
    requires: "authored",
    // A Command step always yields a verdict from its exit status and a text of
    // its captured output.
    produces: ["verdict", "text"],
    session: "none",
    preconditions: "executable-on-path",
    capabilityNeeds: [],
    retryableOutcomes: ["failed"],
    reconciliation: "reconciliation-probe",
  },
};

/** The closed set of Workspace prerequisites an authored Step may require. */
export type WorkspacePrerequisite = "git-worktree-root";
export const WORKSPACE_PREREQUISITES: readonly WorkspacePrerequisite[] = [
  "git-worktree-root",
];

/** The two reference forms a Step uses: static asset vs dynamic artifact. */
export type Reference =
  { readonly asset: string } | { readonly artifact: string };

/**
 * Parse the Prompt slot grammar `{{artifact:name}}` out of prompt text. It is
 * substitution only: no conditionals, loops, includes, or expressions. Returns
 * the referenced artifact names in order of appearance (with duplicates).
 */
export function promptSlotReferences(text: string): string[] {
  const names: string[] = [];
  const slot = /\{\{artifact:([a-zA-Z0-9._-]+)\}\}/g;
  for (const match of text.matchAll(slot)) {
    names.push(match[1]);
  }
  return names;
}

/**
 * A `{{...}}` sequence is a valid Prompt slot only if it is exactly
 * `{{artifact:name}}`. Any other `{{...}}` (an expression, an unknown scheme, a
 * malformed name) is rejected so authored prompts cannot smuggle in logic.
 */
export function hasOnlyValidPromptSlots(text: string): boolean {
  const anySlot = /\{\{([^}]*)\}\}/g;
  for (const match of text.matchAll(anySlot)) {
    if (!/^artifact:[a-zA-Z0-9._-]+$/.test(match[1])) return false;
  }
  return true;
}
