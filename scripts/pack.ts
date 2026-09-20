#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
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
} from "./assemble.js";
import { sha256File } from "./release-helpers.js";
import { TARGETS, type CompileTarget } from "./targets.js";

// Packs the three per-platform npm packages (spec #137, ADR 0030) from the same
// candidate bytes the release archives carry (#151), through the one target
// manifest (scripts/targets.ts). It never rebuilds an input: it reads the archive
// candidate manifest that assembly emitted (scripts/assemble.ts) and fails closed
// unless every dist binary and the legal material are byte-identical to that
// candidate, so a package can only ever carry the exact verified archive bytes
// (AC3). Each package declares its exact release version and npm os/cpu
// constraints (AC1) and contains only its executable, LICENSE, and
// THIRD-PARTY-NOTICES.md — no lifecycle script (AC2). Bun's own `bun pm pack`
// builds the tarball, so the npm channel needs no Node toolchain to assemble.
// Like assembly, packing is cut once: a prior package manifest must agree.

export const PACKAGE_MANIFEST_FILE = "package-manifest.json";

// npm gates install on `os`/`cpu`, but its `os` tokens are not the support-matrix
// names the target manifest owns (the `cpu` tokens x64/arm64 already match). Keyed
// by that os union so a new target OS fails to compile until it is mapped here.
export const NPM_OS: Record<CompileTarget["os"], "win32" | "darwin" | "linux"> =
  {
    windows: "win32",
    macos: "darwin",
    linux: "linux",
  };

export interface PlatformPackage {
  readonly key: string;
  /** The npm package name (@secantdev/secant-<target>), from the target manifest. */
  readonly package: string;
  /** npm `os` constraint token. */
  readonly os: string;
  /** npm `cpu` constraint token. */
  readonly cpu: string;
  readonly executable: string;
  /** SHA-256 of the packed executable — equals the archive candidate's binary digest (AC3). */
  readonly binarySha256: string;
  /** Packed tarball filename, as `bun pm pack` named it. */
  tarball: string;
  /** SHA-256 of the packed tarball as a consumer receives it. */
  tarballSha256: string;
}

export interface PackageManifest {
  readonly version: string;
  readonly licenseSha256: string;
  readonly noticesSha256: string;
  readonly packages: PlatformPackage[];
}

/** The exact package.json for one platform package: the exact release version and
 *  the target's npm os/cpu constraints (AC1), the executable and legal files as
 *  the only shipped contents (AC2), and no lifecycle script of any kind (AC2).
 *  `preferUnplugged` keeps the native binary a real on-disk file under Yarn PnP. */
export function platformPackageJson(
  target: CompileTarget,
  version: string,
): Record<string, unknown> {
  return {
    name: target.package,
    version,
    description: `The ${target.os} ${target.cpu} Secant executable, carried for @secantdev/secant.`,
    license: "MIT",
    os: [NPM_OS[target.os]],
    cpu: [target.cpu],
    preferUnplugged: true,
    files: [target.executable, LICENSE_FILE, NOTICES_FILE],
  };
}

/** Compute the platform-package plan from the assembled archive candidate: read
 *  the candidate manifest assembly emitted, then re-hash the dist binaries and
 *  legal material and fail closed unless they are byte-identical to that candidate
 *  (AC3). Pure I/O (hashing) with no subprocess — only `packPlatformPackages`'s
 *  `bun pm pack` spawns a tool — which is why this half is what the deterministic
 *  suite tests. */
export async function computePackages(options: {
  projectRoot: string;
  distDir?: string;
  releaseDir?: string;
}): Promise<{
  manifest: PackageManifest;
  packageJson: Record<string, Record<string, unknown>>;
}> {
  const { projectRoot } = options;
  const distDir = options.distDir ?? join(projectRoot, "dist");
  const releaseDir = options.releaseDir ?? join(distDir, "release");

  const candidatePath = join(releaseDir, MANIFEST_FILE);
  if (!existsSync(candidatePath)) {
    throw new Error(
      `Archive candidate manifest missing: ${candidatePath}. Run \`bun run scripts/assemble.ts\` first; packing carries the assembled candidate bytes, never a rebuild.`,
    );
  }
  const candidate: CandidateManifest = JSON.parse(
    readFileSync(candidatePath, "utf8"),
  );

  const licenseSha256 = await sha256File(join(projectRoot, LICENSE_FILE));
  const noticesSha256 = await sha256File(join(projectRoot, NOTICES_FILE));
  if (
    licenseSha256 !== candidate.licenseSha256 ||
    noticesSha256 !== candidate.noticesSha256
  ) {
    throw new Error(
      "Legal-material digest disagreement with the archive candidate manifest.",
    );
  }

  const packages: PlatformPackage[] = [];
  const packageJson: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(TARGETS)) {
    const target = TARGETS[key];
    const archiveTarget = candidate.targets.find((t) => t.key === key);
    if (archiveTarget === undefined) {
      throw new Error(`Archive candidate manifest has no target ${key}.`);
    }
    const binaryPath = join(distDir, target.outfile);
    if (!existsSync(binaryPath)) {
      throw new Error(
        `Candidate binary missing for ${key}: ${binaryPath}. Packing never builds an input.`,
      );
    }
    const binarySha256 = await sha256File(binaryPath);
    if (binarySha256 !== archiveTarget.binarySha256) {
      throw new Error(
        `Candidate binary digest disagreement for ${key}: dist bytes differ from the assembled archive candidate.`,
      );
    }
    packages.push({
      key,
      package: target.package,
      os: NPM_OS[target.os],
      cpu: target.cpu,
      executable: target.executable,
      binarySha256,
      tarball: "",
      tarballSha256: "",
    });
    packageJson[key] = platformPackageJson(target, candidate.version);
  }
  return {
    manifest: {
      version: candidate.version,
      licenseSha256,
      noticesSha256,
      packages,
    },
    packageJson,
  };
}

export function assertPackagesAgree(
  prior: PackageManifest,
  next: PackageManifest,
): void {
  if (prior.version !== next.version) {
    throw new Error(
      `Package version disagreement: the existing manifest is ${prior.version}, the inputs are ${next.version}.`,
    );
  }
  if (
    prior.licenseSha256 !== next.licenseSha256 ||
    prior.noticesSha256 !== next.noticesSha256
  ) {
    throw new Error(
      "Package legal-material digest disagreement with the existing manifest.",
    );
  }
  if (prior.packages.length !== next.packages.length) {
    throw new Error("Package identity disagreement: the target set changed.");
  }
  const identityFields: (keyof PlatformPackage)[] = [
    "package",
    "os",
    "cpu",
    "executable",
  ];
  const priorByKey = new Map(prior.packages.map((pkg) => [pkg.key, pkg]));
  for (const pkg of next.packages) {
    const before = priorByKey.get(pkg.key);
    if (before === undefined) {
      throw new Error(
        `Package identity disagreement: the existing manifest has no target ${pkg.key}.`,
      );
    }
    for (const field of identityFields) {
      if (before[field] !== pkg[field]) {
        throw new Error(
          `Package identity disagreement for ${pkg.key}: ${field} changed.`,
        );
      }
    }
    if (before.binarySha256 !== pkg.binarySha256) {
      throw new Error(
        `Package binary digest disagreement for ${pkg.key}: the input differs from the packed candidate.`,
      );
    }
  }
}

/** Pack the staged package into an npm tarball with `bun pm pack` (Bun's own
 *  packer — no Node toolchain, ADR 0030), then move it beside the manifest and
 *  return its filename. */
export function packTarball(stageDir: string, outDir: string): string {
  const before = new Set(readdirSync(stageDir));
  const result = spawnSync("bun", ["pm", "pack"], {
    cwd: stageDir,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `bun pm pack failed in ${stageDir} (status ${result.status}): ${result.stderr}`,
    );
  }
  const produced = readdirSync(stageDir).filter(
    (name) => name.endsWith(".tgz") && !before.has(name),
  );
  if (produced.length !== 1) {
    throw new Error(
      `bun pm pack produced ${produced.length} tarballs in ${stageDir}, expected 1.`,
    );
  }
  renameSync(join(stageDir, produced[0]), join(outDir, produced[0]));
  return produced[0];
}

export async function packPlatformPackages(options: {
  projectRoot: string;
  distDir?: string;
  releaseDir?: string;
  outDir?: string;
}): Promise<PackageManifest> {
  const { projectRoot } = options;
  const distDir = options.distDir ?? join(projectRoot, "dist");
  const releaseDir = options.releaseDir ?? join(distDir, "release");
  const outDir = options.outDir ?? join(distDir, "packages");

  const { manifest: next, packageJson } = await computePackages({
    projectRoot,
    distDir,
    releaseDir,
  });

  // Immutability: a prior package manifest must agree on version, legal material,
  // and every identity and input-binary digest. A disagreement means the inputs
  // changed under an already-packed candidate; fail closed rather than silently
  // re-pack it — a release is cut once (#150).
  const manifestPath = join(outDir, PACKAGE_MANIFEST_FILE);
  if (existsSync(manifestPath)) {
    const prior: PackageManifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    );
    assertPackagesAgree(prior, next);
    for (const pkg of prior.packages) {
      if (!existsSync(join(outDir, pkg.tarball))) {
        throw new Error(
          `Package manifest references a missing tarball: ${pkg.tarball}. Clear ${outDir} to re-pack the candidate.`,
        );
      }
    }
    return prior;
  }

  const licensePath = join(projectRoot, LICENSE_FILE);
  const noticesPath = join(projectRoot, NOTICES_FILE);
  mkdirSync(outDir, { recursive: true });
  for (const pkg of next.packages) {
    const source = join(distDir, TARGETS[pkg.key].outfile);
    const stageDir = join(outDir, `.stage-${pkg.key}`);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });

    const innerPath = join(stageDir, pkg.executable);
    copyFileSync(source, innerPath);
    // Carry the executable bit into the tarball so npm installs a runnable binary
    // (OpenCode packs its platform binaries the same way).
    chmodSync(innerPath, 0o755);
    copyFileSync(licensePath, join(stageDir, LICENSE_FILE));
    copyFileSync(noticesPath, join(stageDir, NOTICES_FILE));
    writeFileSync(
      join(stageDir, "package.json"),
      `${JSON.stringify(packageJson[pkg.key], null, 2)}\n`,
    );

    pkg.tarball = packTarball(stageDir, outDir);
    pkg.tarballSha256 = await sha256File(join(outDir, pkg.tarball));
    rmSync(stageDir, { recursive: true, force: true });
  }

  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

if (import.meta.main) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = await packPlatformPackages({ projectRoot });
  const outDir = join(projectRoot, "dist", "packages");
  console.log(
    `Packed ${manifest.packages.length} platform packages (@secantdev/secant@${manifest.version}) into ${outDir}:`,
  );
  for (const pkg of manifest.packages) {
    console.log(
      `  ${pkg.tarball}  ${pkg.package}  sha256:${pkg.tarballSha256}`,
    );
  }
}
