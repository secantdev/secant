import {
  type ArtifactType,
  type AssetKind,
  type AuthoredManifest,
  type CommandInvocation,
  type CommandParams,
  FRESH_SESSION,
  hasOnlyValidPromptSlots,
  type PlatformOverride,
  promptSlotReferences,
  type Reference,
  type RoutingNode,
  type Step,
  STEP_KINDS,
} from "./workflow.js";

// ---------------------------------------------------------------------------
// Composition check (#13, #9, spec #49)
//
// Proves a validated manifest composes: every reference and binding resolves
// statically, so a Bundle that builds is a Bundle that can run. It executes,
// loads, and fetches nothing (ADR 0021) — the prompt and schema asset *text* it
// inspects is supplied by the Bundle build, which already reads those files.
//
// A private submodule of the Workflow Module, re-exported by the entry: the
// static authored vocabulary and this check are two nameable concerns, and the
// tests are already split at that seam.
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
  const warn = (code: string, target: string, explanation: string): void => {
    findings.push({ code, severity: "warning", target, explanation });
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

  // The reserved `fresh` Session opens an isolated Session per Attempt, so two
  // Agent Steps both naming it read as sharing a conversation but do not. Name
  // that at build time (there is no runtime signal) rather than let the author
  // discover it from behaviour; a single `fresh` Step is unambiguous.
  const freshSteps = flattenSteps(manifest.routing).filter(
    (step) =>
      (step.kind === "agent" || step.kind === "interactive-agent") &&
      step.session === FRESH_SESSION,
  );
  if (freshSteps.length > 1) {
    for (const step of freshSteps) {
      warn(
        "fresh-session-not-shared",
        step.id,
        `Step "${step.id}" names the reserved "${FRESH_SESSION}" Session; each "${FRESH_SESSION}" Agent Step opens its own isolated Session per Attempt and does not share one with the other "${FRESH_SESSION}" Steps (${freshSteps.map((other) => other.id).join(", ")}). Name a shared Session explicitly to continue one conversation.`,
      );
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

    // An Agent step (autonomous or interactive) produces no Artifacts in this
    // release: the Run reads the world through its Command steps, and Agent-step
    // publication is deferred to a later spec (#116, spec story: "Declared
    // `produces` on an Agent step is a Composition error until a later spec
    // defines publication"). Declaring any output fails composition.
    if (
      (step.kind === "agent" || step.kind === "interactive-agent") &&
      (step.produces?.length ?? 0) > 0
    ) {
      error(
        "agent-produces-unsupported",
        step.id,
        `Step "${step.id}" is a ${step.kind} Step that declares produces, but an Agent Step produces no Artifacts in this release.`,
      );
    }

    // A Step kind with a fixed `produces` (Command: verdict + text) may only
    // author outputs of those types, so execution's deterministic-Verdict mapping
    // (exit status -> verdict, captured output -> text) covers every output. A
    // kind that authors its outputs (agents) fixes nothing here.
    const fixedProduces = STEP_KINDS[step.kind].produces;
    if (Array.isArray(fixedProduces)) {
      for (const produced of step.produces ?? []) {
        if (!fixedProduces.includes(produced.type)) {
          error(
            "produces-type-unsupported",
            step.id,
            `Step "${step.id}" produces "${produced.name}" as ${produced.type}, but a ${step.kind} Step produces only ${fixedProduces.join(" or ")}.`,
          );
        }
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
      // An authored Human Gate is a top-level Step only (#108): a Repeat group's
      // in-loop pause is its Review checkpoint, and the engine does not drive an
      // authored gate to rest inside the loop. Reject it here rather than let it
      // produce a Run that blocks with no clean resume.
      for (const step of steps) {
        if (step.kind === "human-gate") {
          error(
            "human-gate-in-repeat",
            `${path}.steps`,
            `Step "${step.id}" is a human-gate inside a Repeat group; authored Human Gates are top-level Steps only (a Repeat group's in-loop pause is its Review checkpoint).`,
          );
        }
        // An interactive-agent Step hands its Session to the human for turn-taking
        // and rests `blocked` until the human ends it (#122); like an authored gate
        // it is a top-level pause, not an in-loop one, so reject it inside a Repeat
        // group rather than let it block with no clean resume.
        if (step.kind === "interactive-agent") {
          error(
            "interactive-agent-in-repeat",
            `${path}.steps`,
            `Step "${step.id}" is an interactive-agent inside a Repeat group; interactive-agent Steps hand the Session to the human and are top-level Steps only (a Repeat group's in-loop pause is its Review checkpoint).`,
          );
        }
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

/** Whether any Step in a routing declares Harness capability needs. This is the
 *  shared static fact used by launch admission and execution composition. */
export function routingNeedsHarness(routing: readonly RoutingNode[]): boolean {
  return flattenSteps(routing).some(
    (step) => STEP_KINDS[step.kind].capabilityNeeds.length > 0,
  );
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
