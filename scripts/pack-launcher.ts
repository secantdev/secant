#!/usr/bin/env bun
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LICENSE_FILE,
  MANIFEST_FILE,
  NOTICES_FILE,
  type CandidateManifest,
  sha256,
} from "./assemble.js";
import { NPM_OS, packTarball } from "./pack.js";
import { TARGETS } from "./targets.js";

// Packs the thin, script-free npm launcher package `@secantdev/secant` (spec #137,
// ADR 0030) that turns npm/pnpm into a launcher channel rather than a second
// runtime distribution. Unlike the platform packages (scripts/pack.ts) it carries
// NO candidate executable: it ships the Node launcher (bin/secant.mjs), a generated
// host-key -> package/executable map derived from the one target manifest
// (scripts/targets.ts), and the legal material. Its package.json declares
// exact-version optional dependencies on all three platform packages and no
// lifecycle script (AC1/AC2), and no os/cpu, so it installs everywhere and fails at
// runtime with an actionable diagnostic on an unsupported target. It pins the same
// release version the archive candidate carries; like the platform packages it is
// cut once and fails closed if re-packed under a different version or legal material.

export const LAUNCHER_MANIFEST_FILE = "launcher-manifest.json";
/** The launcher entry filename, both in `bin/` and at the packed package root. */
export const LAUNCHER_FILE = "secant.mjs";
/** The generated host-key map filename the launcher reads at runtime. */
export const LAUNCHER_PLATFORMS_FILE = "platforms.json";

export interface LauncherPlatformEntry {
  readonly package: string;
  readonly executable: string;
}
export type LauncherPlatforms = Record<string, LauncherPlatformEntry>;

/** The host-key -> package/executable map the shipped launcher reads at runtime,
 *  derived from the one target manifest so the launcher restates none of that
 *  identity. Keyed by `${npmOs}-${cpu}` (e.g. `win32-x64`, `darwin-arm64`,
 *  `linux-x64`) so it matches the launcher's `${process.platform}-${process.arch}`
 *  lookup exactly. */
export function launcherPlatforms(): LauncherPlatforms {
  const platforms: Record<string, LauncherPlatformEntry> = {};
  for (const target of Object.values(TARGETS)) {
    platforms[`${NPM_OS[target.os]}-${target.cpu}`] = {
      package: target.package,
      executable: target.executable,
    };
  }
  return platforms;
}

/** The staged launcher package.json: exact-version optional dependencies on every
 *  platform package (AC1); the bin plus the shipped files (launcher, host-key map,
 *  legal material) and no candidate executable (AC5); no lifecycle script of any
 *  kind (AC1); and no os/cpu, so it installs on every platform and fails at runtime
 *  rather than being refused at install time on an unsupported target. */
export function launcherPackageJson(version: string): Record<string, unknown> {
  const optionalDependencies: Record<string, string> = {};
  for (const target of Object.values(TARGETS)) {
    optionalDependencies[target.package] = version;
  }
  return {
    name: "@secantdev/secant",
    version,
    description:
      "Secant: the thin npm launcher that runs the matching per-platform executable.",
    license: "MIT",
    type: "module",
    bin: { secant: `./${LAUNCHER_FILE}` },
    files: [LAUNCHER_FILE, LAUNCHER_PLATFORMS_FILE, LICENSE_FILE, NOTICES_FILE],
    optionalDependencies,
  };
}

export interface LauncherManifest {
  readonly version: string;
  readonly package: string;
  readonly licenseSha256: string;
  readonly noticesSha256: string;
  /** The generated host-key map the shipped launcher carries — the launcher's
   *  platform identity, re-validated against the live target manifest on re-pack so
   *  a targets.ts identity edit under an already-packed release fails closed. */
  readonly platforms: LauncherPlatforms;
  /** Packed tarball filename, as `bun pm pack` named it. */
  tarball: string;
  /** SHA-256 of the packed tarball as a consumer receives it. */
  tarballSha256: string;
}

export function packLauncher(options: {
  projectRoot: string;
  distDir?: string;
  releaseDir?: string;
  outDir?: string;
}): LauncherManifest {
  const { projectRoot } = options;
  const distDir = options.distDir ?? join(projectRoot, "dist");
  const releaseDir = options.releaseDir ?? join(distDir, "release");
  const outDir = options.outDir ?? join(distDir, "packages");

  // The launcher pins the assembled release version (and its optional dependencies
  // to it), so the archive candidate manifest must exist first — the launcher never
  // invents a version.
  const candidatePath = join(releaseDir, MANIFEST_FILE);
  if (!existsSync(candidatePath)) {
    throw new Error(
      `Archive candidate manifest missing: ${candidatePath}. Run \`bun run scripts/assemble.ts\` first; the launcher pins the assembled release version.`,
    );
  }
  const candidate: CandidateManifest = JSON.parse(
    readFileSync(candidatePath, "utf8"),
  );

  const licensePath = join(projectRoot, LICENSE_FILE);
  const noticesPath = join(projectRoot, NOTICES_FILE);
  const licenseSha256 = sha256(licensePath);
  const noticesSha256 = sha256(noticesPath);
  if (
    licenseSha256 !== candidate.licenseSha256 ||
    noticesSha256 !== candidate.noticesSha256
  ) {
    throw new Error(
      "Legal-material digest disagreement with the archive candidate manifest.",
    );
  }

  const next: LauncherManifest = {
    version: candidate.version,
    package: "@secantdev/secant",
    licenseSha256,
    noticesSha256,
    platforms: launcherPlatforms(),
    tarball: "",
    tarballSha256: "",
  };

  // Immutability: a prior launcher manifest must agree on version and legal
  // material. A disagreement means the inputs changed under an already-packed
  // release; fail closed rather than silently re-pack it — a release is cut once.
  const manifestPath = join(outDir, LAUNCHER_MANIFEST_FILE);
  if (existsSync(manifestPath)) {
    const prior: LauncherManifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    );
    if (prior.version !== next.version) {
      throw new Error(
        `Launcher version disagreement: the existing manifest is ${prior.version}, the inputs are ${next.version}.`,
      );
    }
    if (
      prior.licenseSha256 !== next.licenseSha256 ||
      prior.noticesSha256 !== next.noticesSha256
    ) {
      throw new Error(
        "Launcher legal-material digest disagreement with the existing manifest.",
      );
    }
    // Re-validate platform identity against the live target manifest, the way
    // pack.ts's assertPackagesAgree does: a targets.ts package/executable edit under
    // an already-packed release must fail closed, not silently ship the stale map.
    if (JSON.stringify(prior.platforms) !== JSON.stringify(next.platforms)) {
      throw new Error(
        "Launcher platform-identity disagreement with the existing manifest: the target manifest changed under an already-packed release.",
      );
    }
    if (!existsSync(join(outDir, prior.tarball))) {
      throw new Error(
        `Launcher manifest references a missing tarball: ${prior.tarball}. Clear ${outDir} to re-pack.`,
      );
    }
    return prior;
  }

  const launcherSource = join(projectRoot, "bin", LAUNCHER_FILE);
  if (!existsSync(launcherSource)) {
    throw new Error(`Launcher source missing: ${launcherSource}.`);
  }

  mkdirSync(outDir, { recursive: true });
  const stageDir = join(outDir, ".stage-launcher");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  copyFileSync(launcherSource, join(stageDir, LAUNCHER_FILE));
  // Carry the executable bit so npm installs a runnable bin on POSIX.
  chmodSync(join(stageDir, LAUNCHER_FILE), 0o755);
  writeFileSync(
    join(stageDir, LAUNCHER_PLATFORMS_FILE),
    `${JSON.stringify(launcherPlatforms(), null, 2)}\n`,
  );
  copyFileSync(licensePath, join(stageDir, LICENSE_FILE));
  copyFileSync(noticesPath, join(stageDir, NOTICES_FILE));
  writeFileSync(
    join(stageDir, "package.json"),
    `${JSON.stringify(launcherPackageJson(candidate.version), null, 2)}\n`,
  );

  next.tarball = packTarball(stageDir, outDir);
  next.tarballSha256 = sha256(join(outDir, next.tarball));
  rmSync(stageDir, { recursive: true, force: true });

  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

if (import.meta.main) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = packLauncher({ projectRoot });
  const outDir = join(projectRoot, "dist", "packages");
  console.log(
    `Packed launcher ${manifest.package}@${manifest.version} into ${outDir}:`,
  );
  console.log(`  ${manifest.tarball}  sha256:${manifest.tarballSha256}`);
}
