#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, type CompileTarget } from "./targets.js";

// The M4 release legal-closure inventory (spec #137, story 99). It derives, per
// gated target, the transitive runtime closure ACTUALLY embedded in the shipped
// single-file executable — not the declared-dependency list that the fast
// `checkNoticesCoverage` gate covers (which stays). The closure has three parts,
// unioned across the three targets:
//
//   1. Transitive runtime code: every npm package whose source the compiler
//      admits into the bundle, read from a real `Bun.build` of the exact shared
//      build input (scripts/build.ts `sharedBuildInput`) via the sourcemap
//      `sources`. Each embedded file's version and licence come from the package
//      that owns the file on disk — the deepest `node_modules/` segment — so a
//      hoisted or nested duplicate reports the version of the bytes actually
//      shipped, not a shadowed sibling.
//   2. Platform-native packages: the one `@opentui/core-<os>-<cpu>` native whose
//      library is embedded for each target, keyed off the one target manifest
//      (scripts/targets.ts). The JS graph carries every platform's loader shim, so
//      the graph-derived set strips them all and this re-adds only the shipped one
//      per target.
//   3. Bun redistribution material and copied/vendored material: the embedded Bun
//      runtime (the compiled executable IS Bun) and the vendored OpenCode subset
//      (ADR 0018), which are not npm packages in the graph and so are named as
//      fixed members from the pinned toolchain and the UPSTREAM record.
//
// It runs on the Linux build job after the cross-compile (that job installs every
// platform's @opentui native), emits `inventory-manifest.json` beside the release
// archives, and the `release-legal-closure` consumer verifies that manifest
// against THIRD-PARTY-NOTICES.md and the four shipped channels. Build-only: it is
// re-earned per ADR 0030 and adds no product runtime dependency.

export const INVENTORY_MANIFEST_FILE = "inventory-manifest.json";

export interface ClosureComponent {
  readonly name: string;
  readonly version: string;
  /** The package's declared SPDX licence identifier (or a normalised token). */
  readonly license: string;
}

export interface InventoryManifest {
  readonly version: string;
  /** The pinned Bun toolchain the executable embeds. */
  readonly bun: string;
  /** The embedded runtime closure per gated target. */
  readonly targets: Record<string, ClosureComponent[]>;
  /** The union of every target's closure, deduplicated by name + version. */
  readonly union: ClosureComponent[];
}

const NATIVE_PREFIX = "@opentui/core-";

/** The package directory that owns a bundled source file — the deepest
 *  `node_modules/<pkg>` in its path, so a nested duplicate resolves to its own
 *  package rather than a hoisted sibling. Returns a root-relative dir, or
 *  undefined for first-party (non-node_modules) sources. Pure. */
export function packageDirOfSource(source: string): string | undefined {
  const marker = "node_modules/";
  const last = source.lastIndexOf(marker);
  if (last === -1) return undefined;
  const after = source.slice(last + marker.length);
  const segments = after.split("/");
  const rel = after.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
  if (!rel) return undefined;
  return source.slice(0, last + marker.length) + rel;
}

/** The `@opentui/core-<os>-<cpu>` native package whose library is embedded for a
 *  target — the npm `os` token, not the support-matrix name. Pure. */
export function nativePackageFor(target: CompileTarget): string {
  const nativeOs =
    target.os === "windows"
      ? "win32"
      : target.os === "macos"
        ? "darwin"
        : "linux";
  return `${NATIVE_PREFIX}${nativeOs}-${target.cpu}`;
}

/** Normalise a package.json `license` field to an SPDX-ish token. */
function normaliseLicense(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "type" in raw) {
    return String((raw as { type: unknown }).type);
  }
  return "UNKNOWN";
}

/** The transitive runtime code the compiler admits, minus the platform-native
 *  loader shims (re-added per target). Runs a real build of the shared input; must
 *  run where node_modules is installed. */
async function deriveTransitiveClosure(): Promise<ClosureComponent[]> {
  // Loaded lazily so importing this module for its types and pure helpers (the
  // release-legal-closure consumer, the unit tests) never pulls in the build's
  // `@opentui/solid` plugin: only the build job that actually derives the closure
  // needs it installed.
  const { sharedBuildInput } = await import("./build.js");
  const result = await Bun.build({
    ...sharedBuildInput(),
    sourcemap: "external",
    target: "bun",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(
      "Inventory build failed; cannot derive the runtime closure.",
    );
  }

  const sources = new Set<string>();
  for (const output of result.outputs) {
    if (output.kind === "sourcemap") {
      const map = JSON.parse(await output.text()) as { sources?: string[] };
      for (const source of map.sources ?? []) sources.add(source);
    }
  }

  // The sourcemap `sources` are relative to the build's working directory, which
  // is where the shared input's `./src/cli/main.ts` entrypoint resolved — the
  // project root. Resolve package.json against that same base, not a passed root
  // that could differ, so the version read is always the bytes actually built.
  const buildBase = process.cwd();
  const byKey = new Map<string, ClosureComponent>();
  for (const source of sources) {
    const dir = packageDirOfSource(source);
    if (dir === undefined) continue;
    const manifestPath = join(buildBase, dir, "package.json");
    if (!existsSync(manifestPath)) {
      throw new Error(
        `Embedded source ${source} has no package.json at ${dir}; cannot resolve its shipped version.`,
      );
    }
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      version?: string;
      license?: unknown;
    };
    if (!pkg.name || !pkg.version) continue;
    if (pkg.name.startsWith(NATIVE_PREFIX)) continue; // natives added per target
    byKey.set(`${pkg.name}@${pkg.version}`, {
      name: pkg.name,
      version: pkg.version,
      license: normaliseLicense(pkg.license),
    });
  }
  return [...byKey.values()];
}

/** Bun redistribution material and vendored/copied material — not npm packages in
 *  the graph, so named from the pinned toolchain and the UPSTREAM record. */
function fixedMembers(root: string): ClosureComponent[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  const bunPin = (pkg.packageManager ?? "").split("@")[1];
  if (!bunPin) {
    throw new Error(
      "package.json packageManager does not pin a Bun version; cannot record the embedded Bun runtime.",
    );
  }
  const upstream = readFileSync(join(root, "UPSTREAM"), "utf8");
  const commit = /Commit:\s*(\S+)/.exec(upstream)?.[1];
  if (!commit) {
    throw new Error("UPSTREAM does not record the vendored OpenCode commit.");
  }
  return [
    { name: "bun", version: bunPin, license: "MIT" },
    { name: "OpenCode", version: commit, license: "MIT" },
  ];
}

export async function computeInventory(options: {
  projectRoot: string;
}): Promise<InventoryManifest> {
  const { projectRoot } = options;
  const version = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8"),
  ).version as string;

  const transitive = await deriveTransitiveClosure();
  // The natives ship in lockstep with @opentui/core; its version stamps them. If
  // the graph no longer names @opentui/core (a re-export or a future tree-shake),
  // fail closed rather than stamp the natives with an empty version — an empty
  // version would make the notices coverage check pass vacuously.
  const coreVersion = transitive.find(
    (c) => c.name === "@opentui/core",
  )?.version;
  if (!coreVersion) {
    throw new Error(
      "@opentui/core is not in the derived runtime closure; cannot resolve the embedded native versions.",
    );
  }
  const fixed = fixedMembers(projectRoot);

  const targets: Record<string, ClosureComponent[]> = {};
  const union = new Map<string, ClosureComponent>();
  const add = (component: ClosureComponent) =>
    union.set(`${component.name}@${component.version}`, component);

  for (const [key, target] of Object.entries(TARGETS)) {
    const native: ClosureComponent = {
      name: nativePackageFor(target),
      version: coreVersion,
      license: "MIT",
    };
    const closure = [...transitive, native, ...fixed];
    targets[key] = closure;
    for (const component of closure) add(component);
  }

  const bun = fixed.find((c) => c.name === "bun")?.version ?? "";
  return {
    version,
    bun,
    targets,
    union: [...union.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

if (import.meta.main) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = await computeInventory({ projectRoot });
  const outDir = join(projectRoot, "dist", "release");
  if (!existsSync(outDir)) {
    throw new Error(
      `Release output ${outDir} is missing; run \`bun run scripts/assemble.ts\` before the inventory.`,
    );
  }
  writeFileSync(
    join(outDir, INVENTORY_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `Inventoried ${manifest.union.length} shipped runtime components (@secantdev/secant@${manifest.version}, bun@${manifest.bun}) into ${outDir}/${INVENTORY_MANIFEST_FILE}.`,
  );
}
