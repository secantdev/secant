import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest, type BundleFinding } from "./manifest.js";
import {
  checkComposition,
  PLATFORMS,
  type AssetDecl,
  type AuthoredManifest,
  type CompositionFinding,
  type Platform,
} from "../workflow/workflow.js";
import { writeZip, type ZipEntry } from "./zip.js";

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
  | { readonly ok: false; readonly finding: BundleFinding }
  | { readonly ok: false; readonly composition: readonly CompositionFinding[] };

const MANIFEST_ENTRY = "manifest.json";

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
  if (!parsed.ok) return { ok: false, finding: parsed.finding };
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
    if (compareVersions(floor, min) > 0) min = floor;
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

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
