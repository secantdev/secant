#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LICENSE_FILE,
  MANIFEST_FILE,
  NOTICES_FILE,
  type CandidateManifest,
  sha256,
} from "./assemble.js";
import {
  LAUNCHER_MANIFEST_FILE,
  type LauncherManifest,
} from "./pack-launcher.js";
import { PACKAGE_MANIFEST_FILE, type PackageManifest } from "./pack.js";
import { TARGETS, type CompileTarget } from "./targets.js";

// The M4 release legal-closure gate (spec #137, stories 99/100, #156). It extends
// the fast declared-dependency notices check (`checkNoticesCoverage`, which stays in
// `bun run check`) into a target-specific release gate, and runs as the final step
// of the Linux `build` job — the one place that has cross-compiled all three targets
// and installed every platform's @opentui native, so it needs no separate matrix
// job. It is OS-independent (text and digest comparison only) and spawns no child
// process, so it cannot trip the Bun 1.4.2 child-lifecycle defect (#149/#150).
//
// It derives, per gated target, the transitive runtime closure ACTUALLY embedded in
// the shipped single-file executable, unions it across the three targets, and:
//
//   1. Transitive runtime code: every npm package whose source the compiler admits
//      into the bundle, read from a real `Bun.build` of the exact shared build input
//      (scripts/build.ts `sharedBuildInput`) via the sourcemap `sources`. Each
//      embedded file's version and licence come from the package that owns it on
//      disk — the deepest `node_modules/` segment — so a hoisted or nested duplicate
//      reports the version of the bytes actually shipped, not a shadowed sibling.
//   2. Platform-native packages: the one `@opentui/core-<os>-<cpu>` native whose
//      library is embedded for each target, keyed off the one target manifest. The
//      JS graph carries every platform's loader shim, so the graph-derived set
//      strips them all and this re-adds only the shipped one per target.
//   3. Bun redistribution material and copied/vendored material: the embedded Bun
//      runtime and the vendored OpenCode subset (ADR 0018), named as fixed members
//      from the pinned toolchain and the UPSTREAM record.
//
// then verifies (a) that THIRD-PARTY-NOTICES.md covers that union — every shipped
// component, its shipped version, and its licence family — and (b) that the legal
// material every channel staged (the digests each channel's manifest carries) is the
// source-of-truth material the coverage check verified. The sibling consumer jobs
// already prove the physical bytes in each channel match those manifest digests, so
// this need not re-extract them. Build-only: it is re-earned per ADR 0030 and adds no
// product runtime dependency.

export interface ClosureComponent {
  readonly name: string;
  readonly version: string;
  /** The package's declared SPDX licence identifier (or a normalised token). */
  readonly license: string;
}

export interface Inventory {
  readonly version: string;
  /** The pinned Bun toolchain the executable embeds. */
  readonly bun: string;
  /** The union of every gated target's closure, deduplicated by name + version. */
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
  // unit tests) never pulls in the build's `@opentui/solid` plugin: only the build
  // job that actually derives the closure needs it installed.
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

  // The sourcemap `sources` are relative to the build's working directory, which is
  // where the shared input's `./src/cli/main.ts` entrypoint resolved — the project
  // root. Resolve package.json against that same base so the version read is always
  // the bytes actually built.
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
}): Promise<Inventory> {
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

  const union = new Map<string, ClosureComponent>();
  const add = (component: ClosureComponent) =>
    union.set(`${component.name}@${component.version}`, component);
  for (const component of [...transitive, ...fixed]) add(component);
  for (const target of Object.values(TARGETS)) {
    add({
      name: nativePackageFor(target),
      version: coreVersion,
      license: "MIT",
    });
  }

  return {
    version,
    bun: fixed.find((c) => c.name === "bun")!.version,
    union: [...union.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The licence families a shipped component may carry, each keyed to the marker
 *  text its notices block must contain. A component whose SPDX licence is absent
 *  here fails closed: an unrecognised licence in the shipped closure must be
 *  reviewed, not silently shipped. */
export const LICENSE_TEXT_MARKERS: Record<string, readonly string[]> = {
  MIT: ["MIT License", "(The MIT License)"],
  "Apache-2.0": ["Apache License"],
  ISC: ["The ISC License", "ISC License"],
  "BSD-2-Clause": ["BSD 2-Clause"],
  "BSD-3-Clause": ["BSD 3-Clause"],
  "BlueOak-1.0.0": ["Blue Oak Model License"],
};

/** Notices coverage for the embedded runtime closure (story 99/100). Fails on a
 *  missing shipped component, a stale/absent shipped version, an unrecognised
 *  licence identity, and a missing required licence text — at licence-family
 *  granularity, matching the grouped structure the notices file uses and the
 *  "grouped notices" tolerance. Extra historical notices (a component named that is
 *  no longer shipped) are permitted: this checks coverage, not the reverse.
 *
 *  Named limitations (as `checkNoticesCoverage`): the name and version are matched
 *  as backtick-quoted tokens anywhere in the file, not scoped to the component's own
 *  section, so two components sharing a version string could mask one being stale;
 *  and licence identity is verified per family, not per package. An unrecognised
 *  family still fails closed. Pure. */
export function verifyClosureNotices(
  union: readonly ClosureComponent[],
  notices: string,
): string[] {
  const problems: string[] = [];
  for (const component of union) {
    if (!notices.includes(`\`${component.name}\``)) {
      problems.push(
        `Shipped runtime component ${component.name} has no notices section naming it`,
      );
      continue;
    }
    if (!component.version || !notices.includes(`\`${component.version}\``)) {
      problems.push(
        `Notices for ${component.name} do not name its shipped version \`${component.version}\``,
      );
    }
  }
  const families = [...new Set(union.map((c) => c.license))].sort();
  for (const family of families) {
    const markers = LICENSE_TEXT_MARKERS[family];
    if (markers === undefined) {
      problems.push(
        `A shipped component is licensed ${family}, which is not a recognised licence family; review it before shipping`,
      );
      continue;
    }
    if (!markers.some((marker) => notices.includes(marker))) {
      problems.push(
        `No ${family} licence text is present for a shipped component that carries it`,
      );
    }
  }
  return problems;
}

export interface SourceOfTruth {
  readonly licenseSha256: string;
  readonly noticesSha256: string;
}

export interface ChannelLegal {
  readonly label: string;
  readonly licenseSha256: string;
  readonly noticesSha256: string;
}

/** Every shipped channel staged the source-of-truth legal material (story 100). Each
 *  channel's manifest carries the digest of the LICENSE/notices it staged, and the
 *  sibling consumer jobs already prove the physical bytes in that channel match its
 *  manifest digest — so verifying each manifest digest equals the source of truth the
 *  coverage check ran against proves the whole chain without re-extracting anything.
 *  Pure. */
export function verifyChannelLegalDigests(
  channels: readonly ChannelLegal[],
  truth: SourceOfTruth,
): string[] {
  const problems: string[] = [];
  for (const channel of channels) {
    if (channel.licenseSha256 !== truth.licenseSha256) {
      problems.push(
        `${channel.label} does not ship the shipped ${LICENSE_FILE}`,
      );
    }
    if (channel.noticesSha256 !== truth.noticesSha256) {
      problems.push(
        `${channel.label} does not ship the shipped ${NOTICES_FILE}`,
      );
    }
  }
  return problems;
}

if (import.meta.main) {
  const projectRoot = resolve(import.meta.dir, "..");
  const inventory = await computeInventory({ projectRoot });

  const notices = readFileSync(join(projectRoot, NOTICES_FILE), "utf8");
  const truth: SourceOfTruth = {
    licenseSha256: sha256(join(projectRoot, LICENSE_FILE)),
    noticesSha256: sha256(join(projectRoot, NOTICES_FILE)),
  };

  const releaseDir = join(projectRoot, "dist", "release");
  const packagesDir = join(projectRoot, "dist", "packages");
  const candidate: CandidateManifest = JSON.parse(
    readFileSync(join(releaseDir, MANIFEST_FILE), "utf8"),
  );
  const packages: PackageManifest = JSON.parse(
    readFileSync(join(packagesDir, PACKAGE_MANIFEST_FILE), "utf8"),
  );
  const launcher: LauncherManifest = JSON.parse(
    readFileSync(join(packagesDir, LAUNCHER_MANIFEST_FILE), "utf8"),
  );
  const channels: ChannelLegal[] = [
    {
      label: "Release archives",
      licenseSha256: candidate.licenseSha256,
      noticesSha256: candidate.noticesSha256,
    },
    {
      label: "Platform packages",
      licenseSha256: packages.licenseSha256,
      noticesSha256: packages.noticesSha256,
    },
    {
      label: "Launcher package @secantdev/secant",
      licenseSha256: launcher.licenseSha256,
      noticesSha256: launcher.noticesSha256,
    },
  ];

  const problems = [
    ...verifyClosureNotices(inventory.union, notices),
    ...verifyChannelLegalDigests(channels, truth),
  ];
  if (problems.length > 0) {
    throw new Error(
      `Release legal-closure verification failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  console.log(
    `Release legal closure verified: THIRD-PARTY-NOTICES.md covers ${inventory.union.length} shipped runtime components (@secantdev/secant@${inventory.version}, bun@${inventory.bun}) and every channel ships the shipped legal material.`,
  );
}
