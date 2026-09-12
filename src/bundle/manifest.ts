import semver from "semver";
import { z } from "zod";
import {
  ARTIFACT_HOMES,
  ARTIFACT_TYPES,
  ASSET_KINDS,
  HUMAN_GATE_SHAPES,
  PLATFORMS,
  WORKSPACE_PREREQUISITES,
  type AuthoredManifest,
  type Reference,
} from "../workflow/workflow.js";
import { normalizeRelativePath } from "./relative-path.js";

// Strict, non-executing validation of a Bundle manifest into the trusted
// authored vocabulary (workflow/workflow.ts). The shape is one `zod` v4 schema
// (D2): unknown keys are rejected everywhere, every field constraint carries the
// Secant finding `code` it always used, and a failed parse yields *every* issue,
// not just the first, so they flow into `Problem.fieldViolations` as a list. This
// validates *shape* only; the Composition check that resolves references and
// bindings is the Workflow Module's `checkComposition`, run over the result here.

/** One reason a Bundle was rejected. Application translates this to a Problem. */
export interface BundleFinding {
  readonly code: string;
  readonly message: string;
  /** Dotted manifest field path or an archive entry path. */
  readonly path?: string;
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: AuthoredManifest }
  | {
      readonly ok: false;
      readonly finding: BundleFinding; // the first issue, in document order
      readonly findings: readonly BundleFinding[]; // every issue
    };

/** A packaged manifest carries the builder-owned `requires.engine` too. */
export type PackagedManifestResult =
  | {
      readonly ok: true;
      readonly manifest: AuthoredManifest;
      readonly engine: string; // the declared `>=x.y.z` range
    }
  | {
      readonly ok: false;
      readonly finding: BundleFinding;
      readonly findings: readonly BundleFinding[];
    };

// `semver.valid` decides the grammar, but it is lenient about a leading `v`/`=`
// and surrounding whitespace. Reject those so a version stays byte-identical to
// what an author wrote — Bundle identity is `id@version` compared as an exact
// string, and this is an install-time validation boundary (#72).
function isStrictSemver(value: string): boolean {
  return (
    semver.valid(value) !== null &&
    value === value.trim() &&
    value[0] !== "v" &&
    value[0] !== "="
  );
}

// Lowercase reverse-domain: at least two dot-separated lowercase alnum/hyphen
// segments, no leading/trailing hyphen in a segment.
const REVERSE_DOMAIN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
// A bare PATH-resolved executable name: no separators, spaces, or shell tokens.
const BARE_EXECUTABLE = /^[A-Za-z0-9._+-]+$/;

// --- schema building blocks ------------------------------------------------
//
// `checked` attaches one field constraint as a continuable custom issue: parsing
// carries on after it, so sibling fields still report (zod aborts a schema after
// a non-continuable issue). A `code` becomes the Secant finding `code`; without
// one the issue maps to the generic `invalid-field`, exactly as the hand-rolled
// validator's `str`/`arr`/`nonEmpty` helpers did.

function checked<T>(
  schema: z.ZodType<T>,
  ok: (value: T) => boolean,
  message: string,
  code?: string,
): z.ZodType<T> {
  return schema.check((ctx) => {
    if (!ok(ctx.value)) {
      ctx.issues.push({
        code: "custom",
        message,
        input: ctx.value,
        continue: true,
        ...(code ? { params: { secantCode: code } } : {}),
      });
    }
  }) as z.ZodType<T>;
}

const nonEmptyString = checked(
  z.string(),
  (value) => value.trim() !== "",
  "must be a non-empty string.",
);

const nonNegativeInt = checked(
  z.number(),
  (value) => Number.isInteger(value) && value >= 0,
  "must be a non-negative integer.",
);

// A relative path without traversal, normalized to forward slashes (shared rule,
// D8). The check keeps siblings reporting; the transform normalizes a valid one,
// and returns the raw string for an invalid one that the failed parse discards.
const relativePath = z
  .string()
  .check((ctx) => {
    if (
      ctx.value.trim() === "" ||
      normalizeRelativePath(ctx.value) === undefined
    )
      ctx.issues.push({
        code: "custom",
        message: `"${ctx.value}" must be a relative path without traversal.`,
        input: ctx.value,
        continue: true,
      });
  })
  .transform((value) => normalizeRelativePath(value) ?? value);

const workingDirectory = z
  .string()
  .check((ctx) => {
    if (
      ctx.value !== "." &&
      ctx.value !== "" &&
      normalizeRelativePath(ctx.value) === undefined
    )
      ctx.issues.push({
        code: "custom",
        message: `"${ctx.value}" must be a Workspace-relative directory.`,
        input: ctx.value,
        continue: true,
      });
  })
  .transform((value) =>
    value === "." || value === ""
      ? "."
      : (normalizeRelativePath(value) ?? value),
  );

// A Step reference is exactly `{"asset":"path"}` or `{"artifact":"name"}`; an
// asset path obeys the same relative-path rule. The check reports; the transform
// shapes a valid one into the trusted Reference.
const reference: z.ZodType<Reference> = z
  .record(z.string(), z.unknown())
  .check((ctx) => {
    const value = ctx.value;
    const keys = Object.keys(value);
    const asAsset =
      keys.length === 1 && typeof value.asset === "string"
        ? value.asset
        : undefined;
    const asArtifact = keys.length === 1 && typeof value.artifact === "string";
    const bad =
      (asAsset === undefined && !asArtifact) ||
      (asAsset !== undefined && normalizeRelativePath(asAsset) === undefined);
    if (bad)
      ctx.issues.push({
        code: "custom",
        message: `must be exactly {"asset":"path"} or {"artifact":"name"}.`,
        input: value,
        continue: true,
      });
  })
  .transform((value): Reference =>
    typeof value.asset === "string"
      ? { asset: normalizeRelativePath(value.asset) ?? value.asset }
      : { artifact: typeof value.artifact === "string" ? value.artifact : "" },
  );

const argument = z.union([z.string(), reference]);

const enumField = (values: readonly string[], code: string, label: string) =>
  checked(
    z.string(),
    (value) => values.includes(value),
    `${label} is not one of the known values.`,
    code,
  );

// --- section schemas -------------------------------------------------------

const bundleMeta = z.strictObject({
  id: checked(
    z.string(),
    (value) => REVERSE_DOMAIN.test(value),
    "is not a lowercase reverse-domain id (e.g. io.example.name).",
    "invalid-bundle-id",
  ),
  version: checked(
    z.string(),
    (value) => isStrictSemver(value),
    "is not a strict semantic version.",
    "invalid-bundle-version",
  ),
  name: nonEmptyString,
  description: nonEmptyString,
  authors: z.array(z.string()).optional(),
  license: z.string().optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  notices: z.array(z.string()).optional(),
});

const platforms = checked(
  z.array(enumField(PLATFORMS, "invalid-platform", "platforms entry")),
  (value) => value.length > 0,
  "must be a non-empty subset of windows, macos, linux.",
  "invalid-platform",
);

const launchInput = z
  .strictObject({
    type: enumField(ARTIFACT_TYPES, "invalid-input-type", "type"),
    description: nonEmptyString,
    schema: z.string().optional(),
    choices: z.array(z.string()).optional(),
  })
  .check((ctx) => {
    if (ctx.value.type === "choice" && ctx.value.choices === undefined)
      ctx.issues.push({
        code: "custom",
        message: "choices is required for a choice input.",
        input: ctx.value,
        path: ["choices"],
        continue: true,
      });
  });

const inputs = z.record(z.string(), launchInput);

const asset = z.strictObject({
  path: relativePath,
  kind: enumField(ASSET_KINDS, "invalid-asset-kind", "kind"),
});

const produced = z.strictObject({
  name: nonEmptyString,
  type: checked(
    z.string(),
    (value) => (ARTIFACT_TYPES as readonly string[]).includes(value),
    "is not one of the five artifact types.",
  ),
  home: checked(
    z.string(),
    (value) => (ARTIFACT_HOMES as readonly string[]).includes(value),
    "is not store or workspace.",
  ).optional(),
  path: relativePath.optional(),
});

const stepCommon = {
  id: nonEmptyString,
  requires: z.array(z.string()).optional(),
  produces: z.array(produced).optional(),
  prerequisites: z
    .array(
      checked(
        z.string(),
        (value) =>
          (WORKSPACE_PREREQUISITES as readonly string[]).includes(value),
        "is not a known Workspace prerequisite.",
      ),
    )
    .optional(),
  retry: nonNegativeInt.optional(),
};

const executable = checked(
  z.string(),
  (value) => BARE_EXECUTABLE.test(value),
  "must be a bare PATH-resolved name, not an absolute or shell-shaped command.",
  "invalid-command-executable",
);

const invocationOverride = z.strictObject({
  executable: executable.optional(),
  arguments: z.array(argument).optional(),
  workingDirectory: workingDirectory.optional(),
  env: z.record(z.string(), argument).optional(),
});

const command = z.strictObject({
  executable,
  arguments: z.array(argument),
  workingDirectory: workingDirectory.optional(),
  env: z.record(z.string(), argument).optional(),
  platforms: z
    .strictObject({
      windows: invocationOverride.optional(),
      macos: invocationOverride.optional(),
      linux: invocationOverride.optional(),
    })
    .optional(),
});

const commandStep = z.strictObject({
  ...stepCommon,
  kind: z.literal("command"),
  command,
});
const humanGateStep = z.strictObject({
  ...stepCommon,
  kind: z.literal("human-gate"),
  shape: enumField(HUMAN_GATE_SHAPES, "invalid-gate-shape", "shape"),
  prompt: reference.optional(),
  message: nonEmptyString.optional(),
});
const agentFields = {
  ...stepCommon,
  prompt: reference,
  session: nonEmptyString,
  uses: z.array(reference).optional(),
};
const agentStep = z.strictObject({ ...agentFields, kind: z.literal("agent") });
const interactiveAgentStep = z.strictObject({
  ...agentFields,
  kind: z.literal("interactive-agent"),
});

// Discriminated on `kind`, so a bad field surfaces under the matched Step alone
// (e.g. `routing[0].command.executable`) rather than as an aggregated union.
const step = z.discriminatedUnion("kind", [
  commandStep,
  humanGateStep,
  agentStep,
  interactiveAgentStep,
]);

// A Repeat group's steps are Steps only, so a group nested in a group is rejected
// (groups cannot nest). Repeat group is tried first, so a repeat node's own field
// issue wins the tie over the step branch's "no discriminator".
const repeatGroup = z.strictObject({
  repeat: z.strictObject({
    until: nonEmptyString,
    reviewCheckpoint: z.strictObject({
      // `z.unknown()` base so a non-number `interval` still fails with
      // `invalid-review-checkpoint`, not a generic type error (the hand-rolled
      // validator folded the type and value checks under one code).
      interval: checked(
        z.unknown(),
        (value) =>
          typeof value === "number" && Number.isInteger(value) && value >= 1,
        "must be a positive integer.",
        "invalid-review-checkpoint",
      ),
      message: nonEmptyString,
    }),
    steps: z.array(step),
  }),
});

const routingNode = z.union([repeatGroup, step]);

// `z.unknown()` base so a non-number `formatVersion` still fails with
// `invalid-format-version` rather than a generic type error.
const formatVersion = checked(
  z.unknown(),
  (value) => value === 1,
  "must be the integer 1.",
  "invalid-format-version",
);

const requires = z.strictObject({
  // A builder always writes `>=` then a single semantic version; the `>=` shape
  // is load-bearing (readBundle and the Catalog Projection slice it off).
  engine: checked(
    z.string(),
    (value) => value.startsWith(">=") && isStrictSemver(value.slice(2)),
    'must be a ">=x.y.z" release range.',
    "invalid-engine",
  ),
});

// Authored: `requires` and `platforms` are builder-owned, so authors omit them.
// Packaged: the build wrote `requires` and a mandatory `platforms`.
const authoredManifest = z.strictObject({
  formatVersion,
  bundle: bundleMeta,
  platforms: platforms.optional(),
  inputs,
  assets: z.array(asset),
  routing: z.array(routingNode),
});
const packagedManifest = z.strictObject({
  formatVersion,
  bundle: bundleMeta,
  platforms, // mandatory in a packaged manifest
  inputs,
  assets: z.array(asset),
  routing: z.array(routingNode),
  requires,
});

// --- issue translation -----------------------------------------------------

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function toFinding(
  issue: z.core.$ZodIssue,
  path: readonly PropertyKey[],
): BundleFinding {
  const dotted = formatPath(path);
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0];
    const field = dotted === "" ? key : `${dotted}.${key}`;
    return {
      code: "unknown-field",
      message: `Unknown manifest field: ${field}.`,
      path: field,
    };
  }
  // A Step discriminated-union that matched no `kind` (an unknown Step kind, or a
  // Repeat group nested in a group — indistinguishable here, as zod carries no
  // input on this issue). Reaches here only with empty branch errors.
  if (
    issue.code === "invalid_union" &&
    (issue as { discriminator?: unknown }).discriminator === "kind"
  ) {
    return {
      code: "invalid-step-kind",
      message:
        "is not a known Step kind, or a Repeat group is nested in a Repeat group.",
      ...(dotted !== "" ? { path: dotted } : {}),
    };
  }
  const secantCode =
    issue.code === "custom"
      ? (issue.params as { secantCode?: unknown } | undefined)?.secantCode
      : undefined;
  return {
    code: typeof secantCode === "string" ? secantCode : "invalid-field",
    message: issue.message,
    ...(dotted !== "" ? { path: dotted } : {}),
  };
}

// Every issue becomes a finding, in document order. A `union` that could not pick
// a branch (only rare non-primary cases reach here) recurses into the branch with
// the fewest issues; its nested paths are relative to the union node.
function toFindings(error: z.ZodError): BundleFinding[] {
  const findings: BundleFinding[] = [];
  const visit = (
    issues: readonly z.core.$ZodIssue[],
    base: readonly PropertyKey[],
  ): void => {
    for (const issue of issues) {
      const path = [...base, ...issue.path];
      if (issue.code === "invalid_union" && issue.errors.length > 0) {
        const best = issue.errors.reduce((a, b) =>
          b.length < a.length ? b : a,
        );
        visit(best, path);
        continue;
      }
      findings.push(toFinding(issue, path));
    }
  };
  visit(error.issues, []);
  if (findings.length === 0)
    findings.push({
      code: "invalid-field",
      message: "The manifest is invalid.",
    });
  return findings;
}

type ManifestFailure = {
  readonly ok: false;
  readonly finding: BundleFinding;
  readonly findings: readonly BundleFinding[];
};

function notJson(error: unknown): ManifestFailure {
  const finding: BundleFinding = {
    code: "manifest-not-json",
    message: `manifest.json is not valid JSON: ${(error as Error).message}`,
    path: "manifest.json",
  };
  return { ok: false, finding, findings: [finding] };
}

function fail(error: z.ZodError): ManifestFailure {
  const findings = toFindings(error);
  return { ok: false, finding: findings[0], findings };
}

/** Parse and strictly validate manifest JSON text into a trusted manifest. */
export function validateManifest(text: string): ManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return notJson(error);
  }
  const result = authoredManifest.safeParse(raw);
  if (!result.success) return fail(result.error);
  // The value is validated against the authored vocabulary; the closed enums are
  // typed as `string` in the schema, so this is the one boundary cast.
  return { ok: true, manifest: result.data as unknown as AuthoredManifest };
}

/**
 * Validate a *packaged* manifest — the one a build wrote and an installer reads
 * back from the archive. It is the authored shape plus the builder-owned
 * `requires.engine` and a mandatory `platforms`. This is the same non-executing
 * validator the build runs; the installer additionally re-derives the engine to
 * reject an understated range (see bundle.ts).
 */
export function validatePackagedManifest(text: string): PackagedManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return notJson(error);
  }
  const result = packagedManifest.safeParse(raw);
  if (!result.success) return fail(result.error);
  const { requires: declared, ...manifest } = result.data;
  return {
    ok: true,
    manifest: manifest as unknown as AuthoredManifest,
    engine: declared.engine,
  };
}
