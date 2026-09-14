import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import {
  validateManifest,
  validatePackagedManifest,
  type BundleFinding,
  type PackagedManifestResult,
} from "./manifest.js";
import {
  checkComposition,
  PLATFORMS,
  type AssetDecl,
  type AuthoredManifest,
  type CompositionFinding,
  type Platform,
} from "../workflow/workflow.js";
import { readZip, writeZip, type Budgets, type ZipEntry } from "./zip.js";

// The Bundle Module's ZIP writer and budgets are public through this entry; the
// constrained reader stays private (install goes through `readBundle`, which
// returns the identical findings).
export {
  DEFAULT_BUDGETS,
  readZip,
  writeZip,
  type Budgets,
  type ZipEntry,
  type ZipReadResult,
} from "./zip.js";

// The finding shape Application translates into a Problem; re-exported so callers
// name it from the Module entry rather than reaching into `manifest.ts`.
export type { BundleFinding } from "./manifest.js";

// The Execution summary is a private submodule re-exported by the entry.
export {
  EXECUTION_AUTHORITY_WARNING,
  generateExecutionSummary,
  type BundleExecutionCommand,
  type BundleExecutionSummary,
} from "./execution-summary.js";

const MANIFEST_ENTRY = "manifest.json";

// The Bundle Module reads an authoring folder into validated `.wfb` bytes and
// their digest without executing, loading, or fetching anything. It validates
// the manifest shape (manifest.ts), checks every archive entry belongs to
// exactly one non-overlapping declared asset tree, normalizes the bytes for a
// reproducible build, derives the engine range, ensures the platform set, and
// hashes the exact bytes. It imports only the Workflow vocabulary and Node
// built-ins; there is no ZIP-library dependency (see zip.ts for that decision).

export interface BuiltBundle {
  readonly identity: { readonly id: string; readonly version: string };
  readonly bytes: Uint8Array;
  readonly digest: string; // SHA-256 hex over the exact bytes
  readonly findings: readonly string[]; // advisory build notes
}

export type BuildOutcome =
  | { readonly ok: true; readonly built: BuiltBundle }
  | {
      readonly ok: false;
      readonly finding: BundleFinding;
      // Every manifest field violation, when the manifest failed shape
      // validation; a single-cause failure (archive, asset tree) omits it.
      readonly findings?: readonly BundleFinding[];
    }
  | { readonly ok: false; readonly composition: readonly CompositionFinding[] };

/** What an installer needs from validated archive bytes: identity and digest. */
export interface ReadBundle {
  readonly identity: { readonly id: string; readonly version: string };
  readonly digest: string; // SHA-256 hex over the exact bytes
}

export type ReadOutcome =
  | { readonly ok: true; readonly read: ReadBundle }
  | {
      readonly ok: false;
      readonly finding: BundleFinding;
      readonly findings?: readonly BundleFinding[];
    }
  | { readonly ok: false; readonly composition: readonly CompositionFinding[] };

// Every v1 feature maps to the Secant version that introduced format version 1.
// The builder derives requires.engine as the max over features actually used;
// today they all share one floor, but the table is where a later feature's
// higher floor lands. ponytail: one-version table until a feature raises it.
const V1 = "0.1.0";

/** Build `.wfb` bytes from an authoring folder. Never modifies the folder. */
export function buildBundle(folder: string): BuildOutcome {
  const manifestPath = join(folder, MANIFEST_ENTRY);
  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, "utf8");
  } catch {
    return finding(
      "manifest-missing",
      `No ${MANIFEST_ENTRY} in ${folder}.`,
      MANIFEST_ENTRY,
    );
  }

  const parsed = validateManifest(manifestText);
  if (!parsed.ok)
    return { ok: false, finding: parsed.finding, findings: parsed.findings };
  const manifest = parsed.manifest;

  const entries = walk(folder);
  if ("finding" in entries) return { ok: false, finding: entries.finding };

  const assetCheck = checkAssetTrees(folder, manifest.assets, entries.files);
  if (assetCheck) return { ok: false, finding: assetCheck };

  // The manifest and asset tree are valid; prove it composes before packaging.
  // The check reads no files: it is handed the prompt and schema asset text.
  const composition = checkComposition(
    manifest,
    readTextAssets(folder, manifest),
  );
  // ponytail: every rule emits error-severity today, so a warning-only build
  // still packages. When a warning rule first lands, carry warnings onto the
  // success path (BuiltBundle) too, or they are computed and silently dropped.
  if (composition.some((finding) => finding.severity === "error")) {
    return { ok: false, composition };
  }

  const host = buildHost();
  if (host === undefined) {
    return finding(
      "unsupported-build-host",
      `This OS (${process.platform}) is not a supported build platform.`,
    );
  }
  const platforms = manifest.platforms ?? [host];

  const findings: string[] = [];
  if (manifest.platforms === undefined) {
    findings.push(`Inserted build-host platform: ${host}.`);
  }
  const engine = `>=${deriveEngine(manifest)}`;
  findings.push(`Derived requires.engine ${engine}.`);

  const packaged = canonicalManifest(manifest, platforms, engine);
  const zipEntries: ZipEntry[] = [
    { path: MANIFEST_ENTRY, data: Buffer.from(packaged, "utf8") },
  ];
  for (const file of entries.files) {
    // A file that passed the walk can still fail here (deleted or made
    // unreadable mid-build); translate that into a finding, never a raw throw.
    try {
      zipEntries.push({ path: file, data: readFileSync(join(folder, file)) });
    } catch {
      return finding(
        "asset-read-failed",
        `${file} could not be read while packaging.`,
        file,
      );
    }
  }

  const bytes = writeZip(zipEntries);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    ok: true,
    built: {
      identity: { id: manifest.bundle.id, version: manifest.bundle.version },
      bytes,
      digest,
      findings,
    },
  };
}

function finding(code: string, message: string, path?: string): BuildOutcome {
  return { ok: false, finding: { code, message, ...(path ? { path } : {}) } };
}

/**
 * Read validated `.wfb` bytes for install: enforce the archive rules and budgets
 * (zip.ts), validate the packaged manifest with the same validator the build
 * runs, and independently re-derive the engine to reject an understated range.
 * Executes, loads, and fetches nothing. Both a fresh build and a received file
 * install through here, so the two are indistinguishable once stored. A received
 * archive is proven to compose before it is stored (#100, A41): the same
 * Composition check the build runs, over the archived prompt and schema text,
 * with the same finding codes.
 */
export function readBundle(bytes: Uint8Array, budgets: Budgets): ReadOutcome {
  const archive = readZip(bytes, budgets);
  if (!archive.ok) return archive;

  const parsed = parsePackagedArchive(archive.entries);
  if (!parsed.ok)
    return { ok: false, finding: parsed.finding, findings: parsed.findings };

  const bad = (code: string, message: string, path?: string): ReadOutcome => ({
    ok: false,
    finding: { code, message, ...(path ? { path } : {}) },
  });

  const declared = parsed.engine.slice(">=".length);
  const required = deriveEngine(parsed.manifest);
  if (semver.lt(declared, required)) {
    return bad(
      "engine-understated",
      `requires.engine "${parsed.engine}" understates the ${required} this Bundle actually needs.`,
      "requires.engine",
    );
  }

  const composition = composeArchive(archive.entries, parsed.manifest);
  if (composition.some((finding) => finding.severity === "error")) {
    return { ok: false, composition };
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    ok: true,
    read: {
      identity: {
        id: parsed.manifest.bundle.id,
        version: parsed.manifest.bundle.version,
      },
      digest,
    },
  };
}

/**
 * The manifest-declared asset files inside exact `.wfb` bytes — every archive
 * entry a declared asset path claims (the file itself or a file under a declared
 * directory), never `manifest.json` or an unclaimed entry — or undefined when the
 * bytes are not a readable Bundle. Composition hands this to the Catalog, which
 * derives its read-only asset tree from it without parsing an archive itself
 * (#100, A8).
 */
export function readBundleAssets(
  bytes: Uint8Array,
  budgets: Budgets,
): readonly ZipEntry[] | undefined {
  const archive = readZip(bytes, budgets);
  if (!archive.ok) return undefined;
  const parsed = parsePackagedArchive(archive.entries);
  if (!parsed.ok) return undefined;
  const assets = parsed.manifest.assets;
  return archive.entries.filter((entry) =>
    assets.some((asset) => claims(asset, entry.path)),
  );
}

// --- inspection ------------------------------------------------------------
//
// The read-only facts the `bundle-catalog` Projection needs from stored `.wfb`
// bytes (#54): the validated manifest to shape into a focus, plus its Composition
// findings. The generated Execution summary is the sibling `execution-summary`
// submodule. inspectBundle parses the same packaged manifest `readBundle`
// accepts; it executes, loads, and fetches nothing. Application joins these with
// the Catalog Entry's origin and the running engine version — Bundle imports
// neither, so it returns manifest-derived facts and Application translates them.

/** Validated, execution-free facts read from stored Bundle bytes. */
export interface BundleInspection {
  readonly identity: { readonly id: string; readonly version: string };
  readonly digest: string; // SHA-256 hex over the exact bytes
  readonly engine: string; // the declared `>=x.y.z` range
  readonly platforms: readonly Platform[];
  readonly manifest: AuthoredManifest;
  readonly composition: readonly CompositionFinding[];
}

export type InspectOutcome =
  | { readonly ok: true; readonly inspection: BundleInspection }
  | {
      readonly ok: false;
      readonly finding: BundleFinding;
      readonly findings?: readonly BundleFinding[];
    };

/**
 * Read stored `.wfb` bytes into inspection facts: the same packaged-manifest
 * validation `readBundle` runs, plus the Composition check re-run over the
 * archived prompt and schema text so a focus can show its findings. Executes,
 * loads, and fetches nothing.
 */
export function inspectBundle(
  bytes: Uint8Array,
  budgets: Budgets,
  includeComposition = true,
): InspectOutcome {
  const archive = readZip(bytes, budgets);
  if (!archive.ok) return archive;

  const parsed = parsePackagedArchive(archive.entries);
  if (!parsed.ok)
    return { ok: false, finding: parsed.finding, findings: parsed.findings };

  // The list view (summaryOf) never reads composition; opting out skips decoding
  // every prompt/schema asset and re-running the check for a plain `bundle list`.
  const composition = includeComposition
    ? composeArchive(archive.entries, parsed.manifest)
    : [];
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    ok: true,
    inspection: {
      identity: {
        id: parsed.manifest.bundle.id,
        version: parsed.manifest.bundle.version,
      },
      digest,
      engine: parsed.engine,
      platforms: parsed.manifest.platforms ?? [],
      manifest: parsed.manifest,
      composition,
    },
  };
}

// Find, decode, and validate the packaged manifest in a read archive — the one
// step `readBundle` (install) and `inspectBundle` (projection) share before they
// diverge, so the manifest-entry, UTF-8, and shape rejections stay identical.
function parsePackagedArchive(
  entries: readonly ZipEntry[],
): PackagedManifestResult {
  const manifestEntry = entries.find((entry) => entry.path === MANIFEST_ENTRY);
  if (manifestEntry === undefined) {
    const finding = {
      code: "manifest-missing",
      message: `Archive has no ${MANIFEST_ENTRY}.`,
    };
    return { ok: false, finding, findings: [finding] };
  }
  let manifestText: string;
  try {
    manifestText = new TextDecoder("utf8", { fatal: true }).decode(
      manifestEntry.data,
    );
  } catch {
    const finding = {
      code: "manifest-not-utf8",
      message: `${MANIFEST_ENTRY} is not valid UTF-8.`,
    };
    return { ok: false, finding, findings: [finding] };
  }
  return validatePackagedManifest(manifestText);
}

// The one Composition check over a read archive, shared by install (`readBundle`)
// and inspection (`inspectBundle`) so the two can never diverge on how the
// archived prompt and schema text is decoded or composed.
function composeArchive(
  entries: readonly ZipEntry[],
  manifest: AuthoredManifest,
): readonly CompositionFinding[] {
  return checkComposition(manifest, decodeArchiveTextAssets(entries, manifest));
}

// Decode the archived prompt and schema asset bytes for the Composition check,
// mirroring the build's folder decode: strict UTF-8, `null` on non-UTF-8 bytes.
function decodeArchiveTextAssets(
  entries: readonly ZipEntry[],
  manifest: AuthoredManifest,
): ReadonlyMap<string, string | null> {
  const byPath = new Map(entries.map((entry) => [entry.path, entry.data]));
  const decoder = new TextDecoder("utf8", { fatal: true });
  const texts = new Map<string, string | null>();
  for (const asset of manifest.assets) {
    if (asset.kind !== "prompt" && asset.kind !== "schema") continue;
    const data = byPath.get(asset.path);
    if (data === undefined) {
      texts.set(asset.path, null);
      continue;
    }
    try {
      texts.set(asset.path, decoder.decode(data));
    } catch {
      texts.set(asset.path, null);
    }
  }
  return texts;
}

// The Composition check inspects prompt and schema asset *content*; it cannot
// read files itself (Workflow imports no Node mechanism), so the build decodes
// them here. checkAssetKind already proved each exists as a single file; strict
// UTF-8 decode maps a non-UTF-8 schema to `null` (an invalid schema finding).
function readTextAssets(
  folder: string,
  manifest: AuthoredManifest,
): ReadonlyMap<string, string | null> {
  const texts = new Map<string, string | null>();
  const decoder = new TextDecoder("utf8", { fatal: true });
  for (const asset of manifest.assets) {
    if (asset.kind !== "prompt" && asset.kind !== "schema") continue;
    try {
      texts.set(
        asset.path,
        decoder.decode(readFileSync(join(folder, asset.path))),
      );
    } catch {
      texts.set(asset.path, null);
    }
  }
  return texts;
}

function buildHost(): Platform | undefined {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return undefined;
  }
}

// --- filesystem walk -------------------------------------------------------

function walk(root: string): { files: string[] } | { finding: BundleFinding } {
  const files: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relative = stack.pop() as string;
    const absolute = relative === "" ? root : join(root, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childRelative =
        relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (childRelative === MANIFEST_ENTRY) continue;
      // lstat so a symlink is seen as a symlink, not its target.
      const stats = lstatSync(join(root, childRelative));
      if (stats.isDirectory()) {
        stack.push(childRelative);
      } else if (stats.isFile()) {
        files.push(childRelative);
      } else {
        return {
          finding: {
            code: "invalid-archive-entry",
            message: `${childRelative} is not a regular file; a Bundle archives regular files only.`,
            path: childRelative,
          },
        };
      }
    }
  }
  return { files: files.sort() };
}

// --- asset-tree validation -------------------------------------------------

function checkAssetTrees(
  folder: string,
  assets: readonly AssetDecl[],
  files: readonly string[],
): BundleFinding | undefined {
  // Overlap: no declared asset path may equal or be an ancestor of another.
  for (let i = 0; i < assets.length; i++) {
    for (let j = i + 1; j < assets.length; j++) {
      const a = assets[i].path;
      const b = assets[j].path;
      if (a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)) {
        return {
          code: "overlapping-asset-trees",
          message: `Asset trees overlap: "${a}" and "${b}" cannot share entries.`,
          path: b,
        };
      }
    }
  }

  for (const asset of assets) {
    const kindError = checkAssetKind(folder, asset);
    if (kindError) return kindError;
  }

  // Claim: every archived file belongs to exactly one asset tree.
  for (const file of files) {
    if (!assets.some((asset) => claims(asset, file))) {
      return {
        code: "unclaimed-entry",
        message: `${file} is outside every declared asset tree; declare it as an asset or remove it.`,
        path: file,
      };
    }
  }
  return undefined;
}

function claims(asset: AssetDecl, file: string): boolean {
  return file === asset.path || file.startsWith(`${asset.path}/`);
}

function checkAssetKind(
  folder: string,
  asset: AssetDecl,
): BundleFinding | undefined {
  const absolute = join(folder, asset.path);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    return {
      code: "asset-not-found",
      message: `Asset "${asset.path}" (${asset.kind}) does not exist.`,
      path: asset.path,
    };
  }
  const mismatch = (why: string): BundleFinding => ({
    code: "asset-kind-mismatch",
    message: `Asset "${asset.path}" is declared ${asset.kind} but ${why}.`,
    path: asset.path,
  });
  switch (asset.kind) {
    case "prompt":
      if (!stats.isFile()) return mismatch("is not a file");
      if (!/\.(?:txt|md)$/i.test(asset.path))
        return mismatch("is not a .txt or .md file");
      return undefined;
    case "schema":
      if (!stats.isFile()) return mismatch("is not a file");
      if (!/\.json$/i.test(asset.path)) return mismatch("is not a .json file");
      return undefined;
    case "script":
      return stats.isFile() ? undefined : mismatch("is not a file");
    case "skill":
      if (!stats.isDirectory()) return mismatch("is not a directory");
      try {
        if (!lstatSync(join(absolute, "SKILL.md")).isFile())
          return mismatch("has no root SKILL.md file");
      } catch {
        return mismatch("has no root SKILL.md file");
      }
      return undefined;
    case "resource":
      return stats.isFile() || stats.isDirectory()
        ? undefined
        : mismatch("is not a regular file or directory");
  }
}

// --- normalization ---------------------------------------------------------

function deriveEngine(manifest: AuthoredManifest): string {
  const features = new Set<string>(["format:1"]);
  for (const [, input] of Object.entries(manifest.inputs))
    features.add(`input:${input.type}`);
  for (const asset of manifest.assets) features.add(`asset:${asset.kind}`);
  for (const node of manifest.routing) collectStepFeatures(node, features);
  let min = V1;
  for (const feature of features) {
    const floor = FEATURE_MINIMUMS[feature] ?? V1;
    if (semver.gt(floor, min)) min = floor;
  }
  return min;
}

const FEATURE_MINIMUMS: Readonly<Record<string, string>> = {
  // Every v1 feature entered at the format's introduction. New entries here
  // when a later feature raises the floor.
  "format:1": V1,
};

function collectStepFeatures(
  node: AuthoredManifest["routing"][number],
  features: Set<string>,
): void {
  if ("repeat" in node) {
    features.add("routing:repeat-group");
    for (const step of node.repeat.steps) collectStepFeatures(step, features);
    return;
  }
  features.add(`step:${node.kind}`);
  for (const prereq of node.prerequisites ?? [])
    features.add(`prereq:${prereq}`);
  for (const produced of node.produces ?? []) {
    if (produced.home === "workspace") features.add("home:workspace");
  }
  if (node.kind === "command" && node.command.platforms)
    features.add("command:platform-overrides");
}

function canonicalManifest(
  manifest: AuthoredManifest,
  platforms: readonly Platform[],
  engine: string,
): string {
  // Fixed top-level field order; platforms in canonical OS order; every object
  // key sorted recursively so authored key order never changes the bytes.
  const packaged = {
    formatVersion: manifest.formatVersion,
    bundle: manifest.bundle,
    requires: { engine },
    platforms: PLATFORMS.filter((platform) => platforms.includes(platform)),
    inputs: manifest.inputs,
    assets: manifest.assets,
    routing: manifest.routing,
  };
  return `${JSON.stringify(canonicalize(packaged), null, 2)}\n`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}
