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

// ---------------------------------------------------------------------------
// Authored manifest vocabulary
//
// The validated shape a Bundle manifest is written against. The Bundle Module's
// validator (bundle/manifest.ts) parses untrusted JSON into these trusted values
// at the archive ingress; the Composition check below runs over the result and
// never touches JSON, bytes, or the filesystem. The vocabulary lives here rather
// than in Bundle because it is authored value vocabulary the check must consult
// and Bundle imports Workflow, not the reverse.
// ---------------------------------------------------------------------------

/** The three supported operating systems, in canonical order. */
export type Platform = "windows" | "macos" | "linux";
export const PLATFORMS: readonly Platform[] = ["windows", "macos", "linux"];

/** The five Bundle Asset kinds. */
export type AssetKind = "prompt" | "skill" | "schema" | "script" | "resource";
export const ASSET_KINDS: readonly AssetKind[] = [
  "prompt",
  "skill",
  "schema",
  "script",
  "resource",
];

export interface BundleMeta {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly authors?: readonly string[];
  readonly license?: string;
  readonly homepage?: string;
  readonly repository?: string;
  readonly keywords?: readonly string[];
  readonly notices?: readonly string[];
}

export interface LaunchInput {
  readonly type: ArtifactType;
  readonly description: string;
  readonly schema?: string;
  readonly choices?: readonly string[];
}

export interface AssetDecl {
  readonly path: string;
  readonly kind: AssetKind;
}

export interface ProducedArtifact {
  readonly name: string;
  readonly type: ArtifactType;
  readonly home?: ArtifactHome;
  readonly path?: string;
}

export interface CommandInvocation {
  readonly executable: string;
  readonly arguments: readonly (string | Reference)[];
  readonly workingDirectory?: string;
  readonly env?: Readonly<Record<string, string | Reference>>;
}

export interface CommandParams extends CommandInvocation {
  readonly platforms?: Readonly<Partial<Record<Platform, PlatformOverride>>>;
}
export type PlatformOverride = Partial<CommandInvocation>;

export interface StepCommon {
  readonly id: string;
  readonly kind: StepKindName;
  readonly requires?: readonly string[];
  readonly produces?: readonly ProducedArtifact[];
  readonly prerequisites?: readonly WorkspacePrerequisite[];
  readonly retry?: number;
}
export interface AgentStep extends StepCommon {
  readonly kind: "agent" | "interactive-agent";
  readonly prompt: Reference;
  readonly session: string;
  readonly uses?: readonly Reference[];
}
export interface CommandStep extends StepCommon {
  readonly kind: "command";
  readonly command: CommandParams;
}
export interface HumanGateStep extends StepCommon {
  readonly kind: "human-gate";
  readonly shape: HumanGateShape;
  readonly prompt?: Reference;
  readonly message?: string;
}
export type Step = AgentStep | CommandStep | HumanGateStep;

export interface ReviewCheckpoint {
  readonly interval: number;
  readonly message: string;
}
export interface RepeatGroup {
  readonly repeat: {
    readonly until: string;
    readonly reviewCheckpoint: ReviewCheckpoint;
    readonly steps: readonly Step[];
  };
}
export type RoutingNode = Step | RepeatGroup;

export interface AuthoredManifest {
  readonly formatVersion: 1;
  readonly bundle: BundleMeta;
  readonly platforms?: readonly Platform[];
  readonly inputs: Readonly<Record<string, LaunchInput>>;
  readonly assets: readonly AssetDecl[];
  readonly routing: readonly RoutingNode[];
}

// ---------------------------------------------------------------------------
// Composition check (#13, #9, spec #49)
//
// Proves a validated manifest composes: every reference and binding resolves
// statically, so a Bundle that builds is a Bundle that can run. It executes,
// loads, and fetches nothing (ADR 0021) — the prompt and schema asset *text* it
// inspects is supplied by the Bundle build, which already reads those files.
// ---------------------------------------------------------------------------

export type FindingSeverity = "error" | "warning";

/** One reason a manifest does not compose. Any error-severity finding blocks
 *  the build; the surface (build path, headless client) prints these. */
export interface CompositionFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  /** The Step id or the dotted manifest field the finding points at. */
  readonly target: string;
  readonly explanation: string;
}

// ponytail: engine-owned ceiling so a Bundle cannot set a huge interval and
// effectively disable review check-ins. 100 iterations between check-ins is
// already generous; raise here if a real workflow needs a wider cadence.
export const MAX_REVIEW_CHECKPOINT_INTERVAL = 100;

/**
 * Decoded text of every declared `prompt` and `schema` asset, keyed by asset
 * path. `null` marks an asset whose bytes are not valid UTF-8 (an invalid
 * schema). The Bundle build supplies this; the check reads no files itself.
 */
export type TextAssets = ReadonlyMap<string, string | null>;

/** Which asset kinds each reference site may resolve to (#9). */
const PROMPT_KINDS: readonly AssetKind[] = ["prompt"];
const USES_KINDS: readonly AssetKind[] = ["skill", "resource"];
const COMMAND_KINDS: readonly AssetKind[] = ["script", "resource"];

/** Run the Composition check over a validated manifest. Returns every finding;
 *  the caller blocks the build when any is error-severity. */
export function checkComposition(
  manifest: AuthoredManifest,
  textAssets: TextAssets,
): readonly CompositionFinding[] {
  const findings: CompositionFinding[] = [];
  const error = (code: string, target: string, explanation: string): void => {
    findings.push({ code, severity: "error", target, explanation });
  };
  const assetKinds = new Map<string, AssetKind>(
    manifest.assets.map((asset) => [asset.path, asset.kind]),
  );

  // Every Step id is Bundle-unique (#9). Findings target ids, so a collision is
  // caught here — otherwise an author cannot tell which Step a finding points at.
  const seenIds = new Set<string>();
  for (const step of flattenSteps(manifest.routing)) {
    if (seenIds.has(step.id)) {
      error(
        "duplicate-step-id",
        step.id,
        `Step id "${step.id}" is used by more than one Step; ids must be unique.`,
      );
    } else {
      seenIds.add(step.id);
    }
  }

  // A schema-bearing launch input names a valid schema asset (#9).
  for (const [name, input] of Object.entries(manifest.inputs)) {
    if (input.schema !== undefined) {
      checkSchema(
        input.schema,
        `inputs.${name}.schema`,
        assetKinds,
        textAssets,
        error,
      );
    }
  }

  // Bindings accrue in routing order: launch inputs are bound before any Step,
  // each Step's `produces` binds after it runs.
  const bound = new Map<string, ArtifactType>(
    Object.entries(manifest.inputs).map(([name, input]) => [name, input.type]),
  );

  const checkStep = (step: Step, scope: Map<string, ArtifactType>): void => {
    const requires = new Set(step.requires ?? []);
    for (const name of requires) {
      if (!scope.has(name)) {
        error(
          "unbound-artifact",
          step.id,
          `Step "${step.id}" requires artifact "${name}", which no earlier producer or launch input binds.`,
        );
      }
    }

    for (const reference of assetReferences(step)) {
      const kind = assetKinds.get(reference.path);
      if (kind === undefined) {
        error(
          "unresolved-asset-reference",
          step.id,
          `Step "${step.id}" references asset "${reference.path}" (${reference.site}), which is not a declared asset.`,
        );
      } else if (!reference.kinds.includes(kind)) {
        error(
          "asset-reference-kind-mismatch",
          step.id,
          `Step "${step.id}" references asset "${reference.path}" as ${reference.site} but it is a ${kind} asset, not ${reference.kinds.join(" or ")}.`,
        );
      }
    }

    for (const name of artifactReferences(step)) {
      if (!scope.has(name)) {
        error(
          "unbound-artifact",
          step.id,
          `Step "${step.id}" references artifact "${name}", which no earlier producer or launch input binds.`,
        );
      }
    }

    const prompt = "prompt" in step ? step.prompt : undefined;
    if (prompt && "asset" in prompt) {
      const text = textAssets.get(prompt.asset);
      if (typeof text === "string") {
        if (!hasOnlyValidPromptSlots(text)) {
          error(
            "malformed-prompt-slot",
            step.id,
            `Step "${step.id}" prompt "${prompt.asset}" has a {{...}} slot that is not the {{artifact:name}} form.`,
          );
        }
        for (const name of promptSlotReferences(text)) {
          if (!requires.has(name)) {
            error(
              "unknown-prompt-slot",
              step.id,
              `Step "${step.id}" prompt slot {{artifact:${name}}} names an artifact the Step does not require.`,
            );
          }
        }
      } else if (text === null) {
        // Declared prompt asset whose bytes are not valid UTF-8: its slots can
        // never be read, so it fails composition (as an invalid schema does).
        error(
          "invalid-prompt-asset",
          step.id,
          `Step "${step.id}" prompt "${prompt.asset}" is not valid UTF-8 text.`,
        );
      }
    }

    // #9 makes the composition check the authority that every supported platform
    // resolves exactly one invocation. The strict validator already guarantees a
    // non-empty executable, so on a validated manifest this is a backstop; it is
    // the reachable check when the manifest is built directly (as tests do).
    if (step.kind === "command" && manifest.platforms) {
      const unresolved = manifest.platforms.filter((platform) => {
        const executable =
          step.command.platforms?.[platform]?.executable ??
          step.command.executable;
        return typeof executable !== "string" || executable.trim() === "";
      });
      if (unresolved.length > 0) {
        error(
          "command-invocation-unresolved",
          step.id,
          `Command step "${step.id}" does not resolve exactly one invocation on ${unresolved.join(", ")}.`,
        );
      }
    }

    for (const produced of step.produces ?? []) {
      const existing = scope.get(produced.name);
      if (existing !== undefined && existing !== produced.type) {
        error(
          "artifact-type-mismatch",
          step.id,
          `Step "${step.id}" produces artifact "${produced.name}" as ${produced.type}, but it is already bound as ${existing}.`,
        );
      }
      scope.set(produced.name, produced.type);
    }
  };

  manifest.routing.forEach((node, index) => {
    if ("repeat" in node) {
      const path = `routing[${index}].repeat`;
      const { until, reviewCheckpoint, steps } = node.repeat;
      const boundType = bound.get(until);
      if (boundType === undefined) {
        error(
          "verdict-unbound-before-entry",
          `${path}.until`,
          `Repeat group repeats until "${until}", which is not bound before the group is entered.`,
        );
      } else if (boundType !== "verdict") {
        error(
          "artifact-type-mismatch",
          `${path}.until`,
          `Repeat group repeats until "${until}", which is bound as ${boundType}, not a verdict.`,
        );
      }
      if (
        !Number.isInteger(reviewCheckpoint.interval) ||
        reviewCheckpoint.interval < 1 ||
        reviewCheckpoint.interval > MAX_REVIEW_CHECKPOINT_INTERVAL
      ) {
        error(
          "review-checkpoint-out-of-range",
          `${path}.reviewCheckpoint.interval`,
          `reviewCheckpoint.interval ${reviewCheckpoint.interval} must be a positive integer no greater than ${MAX_REVIEW_CHECKPOINT_INTERVAL}.`,
        );
      }
      if (reviewCheckpoint.message.trim() === "") {
        error(
          "review-checkpoint-out-of-range",
          `${path}.reviewCheckpoint.message`,
          "reviewCheckpoint.message must be non-empty plain text.",
        );
      }
      // Steps inside the group start from the pre-entry bindings and accrue in
      // order; the group's producers then bind for the Steps that follow it.
      const scope = new Map(bound);
      for (const step of steps) checkStep(step, scope);
      for (const [name, type] of scope) bound.set(name, type);
    } else {
      checkStep(node, bound);
    }
  });

  return findings;
}

function checkSchema(
  path: string,
  target: string,
  assetKinds: ReadonlyMap<string, AssetKind>,
  textAssets: TextAssets,
  error: (code: string, target: string, explanation: string) => void,
): void {
  const kind = assetKinds.get(path);
  if (kind === undefined) {
    error(
      "invalid-schema-asset",
      target,
      `Schema "${path}" is not a declared asset.`,
    );
    return;
  }
  if (kind !== "schema") {
    error(
      "invalid-schema-asset",
      target,
      `Schema "${path}" is a ${kind} asset, not a schema.`,
    );
    return;
  }
  const text = textAssets.get(path);
  if (typeof text !== "string") {
    error(
      "invalid-schema-asset",
      target,
      `Schema "${path}" is not valid UTF-8 JSON.`,
    );
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    error(
      "invalid-schema-asset",
      target,
      `Schema "${path}" is not valid JSON.`,
    );
    return;
  }
  for (const ref of collectRefs(parsed)) {
    if (typeof ref !== "string" || !ref.startsWith("#")) {
      error(
        "invalid-schema-asset",
        target,
        `Schema "${path}" has a $ref "${String(ref)}" that points outside the document; only in-document (#...) refs are allowed.`,
      );
      return;
    }
  }
}

/** Every Step in routing order, flattening one level of Repeat groups. The
 *  Composition check, the Bundle Execution summary, and the `bundle-catalog`
 *  focus all traverse Steps this way; keep the rule in one place. */
export function flattenSteps(routing: readonly RoutingNode[]): Step[] {
  const steps: Step[] = [];
  for (const node of routing) {
    if ("repeat" in node) steps.push(...node.repeat.steps);
    else steps.push(node);
  }
  return steps;
}

/** Every `$ref` value anywhere in a parsed JSON Schema. */
function collectRefs(value: unknown): unknown[] {
  const refs: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (key === "$ref") refs.push(child);
        else walk(child);
      }
    }
  };
  walk(value);
  return refs;
}

interface AssetSiteReference {
  readonly path: string;
  readonly kinds: readonly AssetKind[];
  readonly site: string;
}

/** Every static asset reference a Step makes, with the kinds its site allows. */
function assetReferences(step: Step): AssetSiteReference[] {
  const references: AssetSiteReference[] = [];
  const add = (
    reference: Reference | undefined,
    kinds: readonly AssetKind[],
    site: string,
  ): void => {
    if (reference && "asset" in reference) {
      references.push({ path: reference.asset, kinds, site });
    }
  };
  if (step.kind === "agent" || step.kind === "interactive-agent") {
    add(step.prompt, PROMPT_KINDS, "prompt");
    for (const use of step.uses ?? []) add(use, USES_KINDS, "uses");
  } else if (step.kind === "human-gate") {
    add(step.prompt, PROMPT_KINDS, "prompt");
  } else if (step.kind === "command") {
    for (const invocation of commandInvocations(step.command)) {
      for (const token of invocation.arguments ?? []) {
        if (typeof token !== "string") add(token, COMMAND_KINDS, "arguments");
      }
      for (const value of Object.values(invocation.env ?? {})) {
        if (typeof value !== "string") add(value, COMMAND_KINDS, "env");
      }
    }
  }
  return references;
}

/** Every dynamic artifact a Step references outside its `requires` list and its
 *  prompt slots — command tokens and agent `uses` — all of which must be bound. */
function artifactReferences(step: Step): string[] {
  const names: string[] = [];
  const add = (reference: Reference): void => {
    if ("artifact" in reference) names.push(reference.artifact);
  };
  if (step.kind === "agent" || step.kind === "interactive-agent") {
    if ("artifact" in step.prompt) add(step.prompt);
    for (const use of step.uses ?? []) add(use);
  } else if (step.kind === "human-gate") {
    if (step.prompt) add(step.prompt);
  } else if (step.kind === "command") {
    for (const invocation of commandInvocations(step.command)) {
      for (const token of invocation.arguments ?? []) {
        if (typeof token !== "string") add(token);
      }
      for (const value of Object.values(invocation.env ?? {})) {
        if (typeof value !== "string") add(value);
      }
    }
  }
  return names;
}

/** The default invocation and every per-platform override of a command. */
function commandInvocations(
  command: CommandParams,
): (CommandInvocation | PlatformOverride)[] {
  return [command, ...Object.values(command.platforms ?? {})];
}
