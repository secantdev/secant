import {
  ARTIFACT_HOMES,
  ARTIFACT_TYPES,
  ASSET_KINDS,
  HUMAN_GATE_SHAPES,
  PLATFORMS,
  STEP_KIND_NAMES,
  WORKSPACE_PREREQUISITES,
  type ArtifactHome,
  type ArtifactType,
  type AssetDecl,
  type AssetKind,
  type AuthoredManifest,
  type BundleMeta,
  type CommandInvocation,
  type CommandParams,
  type HumanGateShape,
  type LaunchInput,
  type Platform,
  type PlatformOverride,
  type ProducedArtifact,
  type Reference,
  type RepeatGroup,
  type RoutingNode,
  type Step,
  type StepCommon,
  type StepKindName,
  type WorkspacePrerequisite,
} from "../workflow/workflow.js";
import semver from "semver";
import { normalizeRelativePath } from "./relative-path.js";

// Strict, non-executing validation of a Bundle manifest into the trusted
// authored vocabulary (workflow/workflow.ts). Every rejection names the
// offending field or entry path so an author can find it. This validates *shape*
// only; the Composition check that resolves references and bindings is the
// Workflow Module's `checkComposition`, run by the build over the result here.

/** One reason a Bundle was rejected. Application translates this to a Problem. */
export interface BundleFinding {
  readonly code: string;
  readonly message: string;
  /** Dotted manifest field path or an archive entry path. */
  readonly path?: string;
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: AuthoredManifest }
  | { readonly ok: false; readonly finding: BundleFinding };

/** A packaged manifest carries the builder-owned `requires.engine` too. */
export type PackagedManifestResult =
  | {
      readonly ok: true;
      readonly manifest: AuthoredManifest;
      readonly engine: string; // the declared `>=x.y.z` range
    }
  | { readonly ok: false; readonly finding: BundleFinding };

// Lowercase reverse-domain: at least two dot-separated lowercase alnum/hyphen
// segments, no leading/trailing hyphen in a segment.
const REVERSE_DOMAIN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
// A bare PATH-resolved executable name: no separators, spaces, or shell tokens.
const BARE_EXECUTABLE = /^[A-Za-z0-9._+-]+$/;

// `semver.valid` decides the grammar, but it is lenient about a leading `v`/`=`
// and surrounding whitespace. Reject those so a version stays byte-identical to
// what an author wrote — Bundle identity is `id@version` compared as an exact
// string, and this is an install-time validation boundary.
function isStrictSemver(value: string): boolean {
  return (
    semver.valid(value) !== null &&
    value === value.trim() &&
    value[0] !== "v" &&
    value[0] !== "="
  );
}

class ManifestError extends Error {
  constructor(readonly finding: BundleFinding) {
    super(finding.message);
  }
}
function fail(code: string, message: string, path?: string): never {
  throw new ManifestError({ code, message, path });
}

/** Parse and strictly validate manifest JSON text into a trusted manifest. */
export function validateManifest(text: string): ManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      finding: {
        code: "manifest-not-json",
        message: `manifest.json is not valid JSON: ${(error as Error).message}`,
        path: "manifest.json",
      },
    };
  }
  try {
    return { ok: true, manifest: readManifest(raw, false) };
  } catch (error) {
    if (error instanceof ManifestError)
      return { ok: false, finding: error.finding };
    throw error;
  }
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
    return {
      ok: false,
      finding: {
        code: "manifest-not-json",
        message: `manifest.json is not valid JSON: ${(error as Error).message}`,
        path: "manifest.json",
      },
    };
  }
  try {
    const manifest = readManifest(raw, true);
    if (manifest.platforms === undefined) {
      fail(
        "invalid-field",
        "A packaged manifest must declare platforms.",
        "platforms",
      );
    }
    return { ok: true, manifest, engine: readEngine(raw) };
  } catch (error) {
    if (error instanceof ManifestError)
      return { ok: false, finding: error.finding };
    throw error;
  }
}

function readEngine(raw: unknown): string {
  const requires = obj(obj(raw, "manifest").requires, "requires");
  reject(requires, ["engine"], "requires");
  const engine = str(requires.engine, "requires.engine");
  // A builder always writes `>=` then a single semantic version; the `>=` shape
  // is load-bearing (readBundle and the Catalog Projection slice it off).
  if (!engine.startsWith(">=") || !isStrictSemver(engine.slice(2))) {
    fail(
      "invalid-engine",
      `requires.engine "${engine}" must be a ">=x.y.z" release range.`,
      "requires.engine",
    );
  }
  return engine;
}

function readManifest(raw: unknown, packaged: boolean): AuthoredManifest {
  const root = obj(raw, "manifest");
  // `requires` and `platforms` are builder-owned; authors omit them. A packaged
  // manifest additionally carries `requires`. Everything else in the closed set
  // is authored.
  reject(
    root,
    [
      "formatVersion",
      "bundle",
      "platforms",
      "inputs",
      "assets",
      "routing",
      ...(packaged ? ["requires"] : []),
    ],
    "",
  );
  if (root.formatVersion !== 1) {
    fail(
      "invalid-format-version",
      "formatVersion must be the integer 1.",
      "formatVersion",
    );
  }
  return {
    formatVersion: 1,
    bundle: readBundleMeta(obj(root.bundle, "bundle")),
    platforms:
      root.platforms === undefined ? undefined : readPlatforms(root.platforms),
    inputs: readInputs(obj(root.inputs, "inputs")),
    assets: readAssets(arr(root.assets, "assets")),
    routing: readRouting(arr(root.routing, "routing")),
  };
}

function readBundleMeta(b: Record<string, unknown>): BundleMeta {
  reject(
    b,
    [
      "id",
      "version",
      "name",
      "description",
      "authors",
      "license",
      "homepage",
      "repository",
      "keywords",
      "notices",
    ],
    "bundle",
  );
  const id = str(b.id, "bundle.id");
  if (!REVERSE_DOMAIN.test(id)) {
    fail(
      "invalid-bundle-id",
      `bundle.id "${id}" is not a lowercase reverse-domain id (e.g. io.example.name).`,
      "bundle.id",
    );
  }
  const version = str(b.version, "bundle.version");
  if (!isStrictSemver(version)) {
    fail(
      "invalid-bundle-version",
      `bundle.version "${version}" is not a strict semantic version.`,
      "bundle.version",
    );
  }
  return {
    id,
    version,
    name: nonEmpty(b.name, "bundle.name"),
    description: nonEmpty(b.description, "bundle.description"),
    ...opt("authors", b.authors, (v) => stringArray(v, "bundle.authors")),
    ...opt("license", b.license, (v) => str(v, "bundle.license")),
    ...opt("homepage", b.homepage, (v) => str(v, "bundle.homepage")),
    ...opt("repository", b.repository, (v) => str(v, "bundle.repository")),
    ...opt("keywords", b.keywords, (v) => stringArray(v, "bundle.keywords")),
    ...opt("notices", b.notices, (v) => stringArray(v, "bundle.notices")),
  };
}

function readPlatforms(raw: unknown): readonly Platform[] {
  const list = arr(raw, "platforms");
  if (list.length === 0)
    fail(
      "invalid-platform",
      "platforms must be a non-empty subset.",
      "platforms",
    );
  return list.map((entry, index) => {
    const value = str(entry, `platforms[${index}]`);
    if (!(PLATFORMS as readonly string[]).includes(value)) {
      fail(
        "invalid-platform",
        `platforms[${index}] "${value}" is not one of windows, macos, linux.`,
        `platforms[${index}]`,
      );
    }
    return value as Platform;
  });
}

function readInputs(
  inputs: Record<string, unknown>,
): Record<string, LaunchInput> {
  const result: Record<string, LaunchInput> = {};
  for (const [name, value] of Object.entries(inputs)) {
    const path = `inputs.${name}`;
    const input = obj(value, path);
    reject(input, ["type", "description", "schema", "choices"], path);
    const type = str(input.type, `${path}.type`);
    if (!(ARTIFACT_TYPES as readonly string[]).includes(type)) {
      fail(
        "invalid-input-type",
        `${path}.type "${type}" is not one of the five artifact types.`,
        `${path}.type`,
      );
    }
    if (type === "choice" && input.choices === undefined) {
      fail(
        "invalid-field",
        `${path}.choices is required for a choice input.`,
        `${path}.choices`,
      );
    }
    result[name] = {
      type: type as ArtifactType,
      description: nonEmpty(input.description, `${path}.description`),
      ...opt("schema", input.schema, (v) => str(v, `${path}.schema`)),
      ...opt("choices", input.choices, (v) =>
        stringArray(v, `${path}.choices`),
      ),
    };
  }
  return result;
}

function readAssets(list: readonly unknown[]): readonly AssetDecl[] {
  return list.map((entry, index) => {
    const path = `assets[${index}]`;
    const asset = obj(entry, path);
    reject(asset, ["path", "kind"], path);
    const kind = str(asset.kind, `${path}.kind`);
    if (!(ASSET_KINDS as readonly string[]).includes(kind)) {
      fail(
        "invalid-asset-kind",
        `${path}.kind "${kind}" is not a known asset kind.`,
        `${path}.kind`,
      );
    }
    return {
      path: relativePath(asset.path, `${path}.path`),
      kind: kind as AssetKind,
    };
  });
}

function readRouting(list: readonly unknown[]): readonly RoutingNode[] {
  return list.map((entry, index) => readNode(entry, `routing[${index}]`, true));
}

function readNode(
  entry: unknown,
  path: string,
  allowGroup: boolean,
): RoutingNode {
  const node = obj(entry, path);
  if ("repeat" in node) {
    if (!allowGroup) {
      fail(
        "nested-repeat-group",
        `${path} is a Repeat group inside a Repeat group; groups cannot nest.`,
        path,
      );
    }
    return readRepeatGroup(node, path);
  }
  return readStep(node, path);
}

function readRepeatGroup(
  node: Record<string, unknown>,
  path: string,
): RepeatGroup {
  reject(node, ["repeat"], path);
  const repeat = obj(node.repeat, `${path}.repeat`);
  reject(repeat, ["until", "reviewCheckpoint", "steps"], `${path}.repeat`);
  const checkpoint = obj(
    repeat.reviewCheckpoint,
    `${path}.repeat.reviewCheckpoint`,
  );
  reject(
    checkpoint,
    ["interval", "message"],
    `${path}.repeat.reviewCheckpoint`,
  );
  const interval = checkpoint.interval;
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < 1
  ) {
    fail(
      "invalid-review-checkpoint",
      `${path}.repeat.reviewCheckpoint.interval must be a positive integer.`,
      `${path}.repeat.reviewCheckpoint.interval`,
    );
  }
  const steps = arr(repeat.steps, `${path}.repeat.steps`).map((step, index) =>
    readNode(step, `${path}.repeat.steps[${index}]`, false),
  ) as Step[];
  return {
    repeat: {
      until: nonEmpty(repeat.until, `${path}.repeat.until`),
      reviewCheckpoint: {
        interval,
        message: nonEmpty(
          checkpoint.message,
          `${path}.repeat.reviewCheckpoint.message`,
        ),
      },
      steps,
    },
  };
}

function readStep(node: Record<string, unknown>, path: string): Step {
  const kind = str(node.kind, `${path}.kind`);
  if (!(STEP_KIND_NAMES as readonly string[]).includes(kind)) {
    fail(
      "invalid-step-kind",
      `${path}.kind "${kind}" is not a known Step kind.`,
      `${path}.kind`,
    );
  }
  const common = [
    "id",
    "kind",
    "requires",
    "produces",
    "prerequisites",
    "retry",
  ];
  const id = nonEmpty(node.id, `${path}.id`);
  const base: StepCommon = {
    id,
    kind: kind as StepKindName,
    ...opt("requires", node.requires, (v) =>
      stringArray(v, `${path}.requires`),
    ),
    ...opt("produces", node.produces, (v) =>
      readProduced(v, `${path}.produces`),
    ),
    ...opt("prerequisites", node.prerequisites, (v) =>
      readPrerequisites(v, `${path}.prerequisites`),
    ),
    ...opt("retry", node.retry, (v) => nonNegativeInt(v, `${path}.retry`)),
  };
  if (kind === "command") {
    reject(node, [...common, "command"], path);
    return {
      ...base,
      kind: "command",
      command: readCommand(
        obj(node.command, `${path}.command`),
        `${path}.command`,
      ),
    };
  }
  if (kind === "human-gate") {
    reject(node, [...common, "shape", "prompt", "message"], path);
    const shape = str(node.shape, `${path}.shape`);
    if (!(HUMAN_GATE_SHAPES as readonly string[]).includes(shape)) {
      fail(
        "invalid-gate-shape",
        `${path}.shape "${shape}" is not approve-reject or free-text.`,
        `${path}.shape`,
      );
    }
    return {
      ...base,
      kind: "human-gate",
      shape: shape as HumanGateShape,
      ...opt("prompt", node.prompt, (v) => reference(v, `${path}.prompt`)),
      ...opt("message", node.message, (v) => nonEmpty(v, `${path}.message`)),
    };
  }
  // agent | interactive-agent
  reject(node, [...common, "prompt", "session", "uses"], path);
  return {
    ...base,
    kind: kind as "agent" | "interactive-agent",
    prompt: reference(node.prompt, `${path}.prompt`),
    session: nonEmpty(node.session, `${path}.session`),
    ...opt("uses", node.uses, (v) =>
      arr(v, `${path}.uses`).map((r, i) => reference(r, `${path}.uses[${i}]`)),
    ),
  };
}

function readProduced(raw: unknown, path: string): readonly ProducedArtifact[] {
  return arr(raw, path).map((entry, index) => {
    const p = `${path}[${index}]`;
    const produced = obj(entry, p);
    reject(produced, ["name", "type", "home", "path"], p);
    const type = str(produced.type, `${p}.type`);
    if (!(ARTIFACT_TYPES as readonly string[]).includes(type)) {
      fail(
        "invalid-field",
        `${p}.type "${type}" is not one of the five artifact types.`,
        `${p}.type`,
      );
    }
    let home: ArtifactHome | undefined;
    if (produced.home !== undefined) {
      const value = str(produced.home, `${p}.home`);
      if (!(ARTIFACT_HOMES as readonly string[]).includes(value)) {
        fail(
          "invalid-field",
          `${p}.home "${value}" is not store or workspace.`,
          `${p}.home`,
        );
      }
      home = value as ArtifactHome;
    }
    return {
      name: nonEmpty(produced.name, `${p}.name`),
      type: type as ArtifactType,
      ...(home ? { home } : {}),
      ...opt("path", produced.path, (v) => relativePath(v, `${p}.path`)),
    };
  });
}

function readPrerequisites(
  raw: unknown,
  path: string,
): readonly WorkspacePrerequisite[] {
  return arr(raw, path).map((entry, index) => {
    const value = str(entry, `${path}[${index}]`);
    if (!(WORKSPACE_PREREQUISITES as readonly string[]).includes(value)) {
      fail(
        "invalid-field",
        `${path}[${index}] "${value}" is not a known Workspace prerequisite.`,
        `${path}[${index}]`,
      );
    }
    return value as WorkspacePrerequisite;
  });
}

function readCommand(
  raw: Record<string, unknown>,
  path: string,
): CommandParams {
  reject(
    raw,
    ["executable", "arguments", "workingDirectory", "env", "platforms"],
    path,
  );
  const invocation = readInvocation(raw, path, true);
  const platforms = raw.platforms;
  if (platforms === undefined) return invocation;
  const overrides = obj(platforms, `${path}.platforms`);
  reject(overrides, PLATFORMS, `${path}.platforms`);
  const result: Partial<Record<Platform, PlatformOverride>> = {};
  for (const [platform, value] of Object.entries(overrides)) {
    const p = `${path}.platforms.${platform}`;
    const override = obj(value, p);
    reject(override, ["executable", "arguments", "workingDirectory", "env"], p);
    result[platform as Platform] = readInvocation(override, p, false);
  }
  return { ...invocation, platforms: result };
}

function readInvocation<Required extends boolean>(
  raw: Record<string, unknown>,
  path: string,
  requireExecutable: Required,
): Required extends true ? CommandInvocation : PlatformOverride {
  const out: {
    executable?: string;
    arguments?: readonly (string | Reference)[];
    workingDirectory?: string;
    env?: Record<string, string | Reference>;
  } = {};
  if (raw.executable !== undefined || requireExecutable) {
    const executable = str(raw.executable, `${path}.executable`);
    if (!BARE_EXECUTABLE.test(executable)) {
      fail(
        "invalid-command-executable",
        `${path}.executable "${executable}" must be a bare PATH-resolved name, not an absolute or shell-shaped command.`,
        `${path}.executable`,
      );
    }
    out.executable = executable;
  }
  if (raw.arguments !== undefined || requireExecutable) {
    out.arguments = arr(raw.arguments, `${path}.arguments`).map(
      (token, index) => argument(token, `${path}.arguments[${index}]`),
    );
  }
  if (raw.workingDirectory !== undefined) {
    out.workingDirectory = safeWorkingDirectory(
      raw.workingDirectory,
      `${path}.workingDirectory`,
    );
  }
  if (raw.env !== undefined) {
    const env = obj(raw.env, `${path}.env`);
    out.env = {};
    for (const [name, value] of Object.entries(env)) {
      out.env[name] = argument(value, `${path}.env.${name}`);
    }
  }
  return out as Required extends true ? CommandInvocation : PlatformOverride;
}

function argument(token: unknown, path: string): string | Reference {
  if (typeof token === "string") return token;
  return reference(token, path);
}

function reference(raw: unknown, path: string): Reference {
  const ref = obj(raw, path);
  const keys = Object.keys(ref);
  if (keys.length === 1 && typeof ref.asset === "string")
    return { asset: relativePath(ref.asset, `${path}.asset`) };
  if (keys.length === 1 && typeof ref.artifact === "string")
    return { artifact: ref.artifact };
  fail(
    "invalid-field",
    `${path} must be exactly {"asset":"path"} or {"artifact":"name"}.`,
    path,
  );
}

// --- primitive helpers -----------------------------------------------------

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(
      "invalid-field",
      `${path || "manifest"} must be a JSON object.`,
      path || undefined,
    );
  }
  return value as Record<string, unknown>;
}
function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value))
    fail("invalid-field", `${path} must be an array.`, path);
  return value;
}
function str(value: unknown, path: string): string {
  if (typeof value !== "string")
    fail("invalid-field", `${path} must be a string.`, path);
  return value;
}
function nonEmpty(value: unknown, path: string): string {
  const s = str(value, path);
  if (s.trim() === "")
    fail("invalid-field", `${path} must be a non-empty string.`, path);
  return s;
}
function stringArray(value: unknown, path: string): readonly string[] {
  return arr(value, path).map((entry, index) =>
    str(entry, `${path}[${index}]`),
  );
}
function nonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail("invalid-field", `${path} must be a non-negative integer.`, path);
  }
  return value;
}
function relativePath(value: unknown, path: string): string {
  const s = nonEmpty(value, path);
  const normalized = normalizeRelativePath(s);
  if (normalized === undefined) {
    fail(
      "invalid-field",
      `${path} "${s}" must be a relative path without traversal.`,
      path,
    );
  }
  return normalized;
}
function safeWorkingDirectory(value: unknown, path: string): string {
  const s = str(value, path);
  if (s === "." || s === "") return ".";
  return relativePath(s, path);
}

/** Reject any key not in `allowed`, naming the first offender's field path. */
function reject(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      const field = path ? `${path}.${key}` : key;
      fail("unknown-field", `Unknown manifest field: ${field}.`, field);
    }
  }
}

/** Spread helper: include an optional key only when authored. */
function opt<T>(
  key: string,
  value: unknown,
  read: (v: unknown) => T,
): Record<string, T> {
  return value === undefined ? {} : { [key]: read(value) };
}
