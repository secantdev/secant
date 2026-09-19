#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { TARGETS, type ArchiveType } from "./targets.js";

// Assembles the three release archives (ADR 0030, spec #137) once from the
// already-built candidate binaries under dist/, through the one authoritative
// target manifest (scripts/targets.ts) so every downstream channel identifies
// and verifies the same bytes (#150). It never rebuilds an input binary: the
// bytes in dist/ are the candidate. Each archive carries the target's inner
// executable (with the consumer-facing name and an executable mode), Secant's
// LICENSE, and THIRD-PARTY-NOTICES.md. It emits a candidate manifest and a
// SHA256SUMS file, and fails closed on any identity/version/digest disagreement
// with an already-assembled candidate — a release is cut once and is immutable.

export const LICENSE_FILE = "LICENSE";
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";
export const MANIFEST_FILE = "candidate-manifest.json";
export const CHECKSUMS_FILE = "SHA256SUMS";

export interface CandidateTarget {
  readonly key: string;
  readonly os: string;
  readonly cpu: string;
  readonly package: string;
  readonly archive: string;
  readonly archiveType: ArchiveType;
  readonly executable: string;
  /** SHA-256 of the input candidate binary — the reproducible immutability anchor. */
  readonly binarySha256: string;
  /** SHA-256 of the assembled archive as consumers receive it. */
  archiveSha256: string;
}

export interface CandidateManifest {
  readonly version: string;
  readonly licenseSha256: string;
  readonly noticesSha256: string;
  readonly targets: CandidateTarget[];
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Create the archive once from the staged contents, using the platform archive
 *  tool (zip / tar are build-only, re-earned per ADR 0030). Runs on the Linux
 *  build job that cross-compiles all three targets. */
function createArchive(
  stageDir: string,
  contents: readonly string[],
  type: ArchiveType,
  outPath: string,
): void {
  const [command, args]: [string, string[]] =
    type === "zip"
      ? ["zip", ["-X", "-q", outPath, ...contents]]
      : ["tar", ["-czf", outPath, ...contents]];
  const result = spawnSync(command, args, { cwd: stageDir, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed to create ${outPath} (status ${result.status}): ${result.stderr}`,
    );
  }
}

function assertAgrees(prior: CandidateManifest, next: CandidateManifest): void {
  if (prior.version !== next.version) {
    throw new Error(
      `Candidate version disagreement: the existing manifest is ${prior.version}, the inputs are ${next.version}.`,
    );
  }
  if (
    prior.licenseSha256 !== next.licenseSha256 ||
    prior.noticesSha256 !== next.noticesSha256
  ) {
    throw new Error(
      "Candidate legal-material digest disagreement with the existing manifest.",
    );
  }
  if (prior.targets.length !== next.targets.length) {
    throw new Error("Candidate identity disagreement: the target set changed.");
  }
  const identityFields: (keyof CandidateTarget)[] = [
    "os",
    "cpu",
    "package",
    "archive",
    "archiveType",
    "executable",
  ];
  const priorByKey = new Map(
    prior.targets.map((target) => [target.key, target]),
  );
  for (const target of next.targets) {
    const before = priorByKey.get(target.key);
    if (before === undefined) {
      throw new Error(
        `Candidate identity disagreement: the existing manifest has no target ${target.key}.`,
      );
    }
    for (const field of identityFields) {
      if (before[field] !== target[field]) {
        throw new Error(
          `Candidate identity disagreement for ${target.key}: ${field} changed.`,
        );
      }
    }
    if (before.binarySha256 !== target.binarySha256) {
      throw new Error(
        `Candidate binary digest disagreement for ${target.key}: the input differs from the assembled candidate.`,
      );
    }
  }
}

export function assembleRelease(options: {
  projectRoot: string;
  distDir?: string;
  outDir?: string;
}): CandidateManifest {
  const { projectRoot } = options;
  const distDir = options.distDir ?? join(projectRoot, "dist");
  const outDir = options.outDir ?? join(distDir, "release");

  const version = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8"),
  ).version as string;

  const licensePath = join(projectRoot, LICENSE_FILE);
  const noticesPath = join(projectRoot, NOTICES_FILE);
  for (const legal of [licensePath, noticesPath]) {
    if (!existsSync(legal)) {
      throw new Error(`Release legal material missing: ${legal}.`);
    }
  }

  // Identity: every declared target's built candidate binary must be present.
  const keys = Object.keys(TARGETS);
  for (const key of keys) {
    const source = join(distDir, TARGETS[key].outfile);
    if (!existsSync(source)) {
      throw new Error(
        `Candidate binary missing for ${key}: ${source}. Run \`bun run scripts/build.ts --all\` first; assembly never builds an input.`,
      );
    }
  }

  const targets: CandidateTarget[] = keys.map((key) => {
    const target = TARGETS[key];
    return {
      key,
      os: target.os,
      cpu: target.cpu,
      package: target.package,
      archive: target.archive,
      archiveType: target.archiveType,
      executable: target.executable,
      binarySha256: sha256(join(distDir, target.outfile)),
      archiveSha256: "",
    };
  });
  const next: CandidateManifest = {
    version,
    licenseSha256: sha256(licensePath),
    noticesSha256: sha256(noticesPath),
    targets,
  };

  // Immutability: a prior candidate manifest must agree on version, legal
  // material, and every input-binary digest. A disagreement means the inputs
  // changed under an already-assembled release; fail closed rather than silently
  // re-cut it. Its archives on disk stay the candidate.
  const manifestPath = join(outDir, MANIFEST_FILE);
  if (existsSync(manifestPath)) {
    const prior: CandidateManifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    );
    assertAgrees(prior, next);
    // The candidate's archives on disk are what the manifest points at; a
    // missing one is a corrupted candidate, not an idempotent no-op.
    for (const target of prior.targets) {
      if (!existsSync(join(outDir, target.archive))) {
        throw new Error(
          `Candidate manifest references a missing archive: ${target.archive}. Clear ${outDir} to re-cut the candidate.`,
        );
      }
    }
    return prior;
  }

  mkdirSync(outDir, { recursive: true });
  for (const target of targets) {
    const source = join(distDir, TARGETS[target.key].outfile);
    const stageDir = join(outDir, `.stage-${target.key}`);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });

    const innerPath = join(stageDir, target.executable);
    copyFileSync(source, innerPath);
    chmodSync(innerPath, 0o755);
    copyFileSync(licensePath, join(stageDir, LICENSE_FILE));
    copyFileSync(noticesPath, join(stageDir, NOTICES_FILE));

    const contents = [target.executable, LICENSE_FILE, NOTICES_FILE].sort();
    const archivePath = join(outDir, target.archive);
    rmSync(archivePath, { force: true });
    createArchive(stageDir, contents, target.archiveType, archivePath);
    rmSync(stageDir, { recursive: true, force: true });
    target.archiveSha256 = sha256(archivePath);
  }

  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  writeFileSync(
    join(outDir, CHECKSUMS_FILE),
    `${targets.map((target) => `${target.archiveSha256}  ${target.archive}`).join("\n")}\n`,
  );
  return next;
}

if (import.meta.main) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = assembleRelease({ projectRoot });
  const outDir = join(projectRoot, "dist", "release");
  console.log(
    `Assembled ${manifest.targets.length} release archives (@secantdev/secant@${manifest.version}) into ${outDir}:`,
  );
  for (const target of manifest.targets) {
    console.log(`  ${target.archive}  sha256:${target.archiveSha256}`);
  }
}
