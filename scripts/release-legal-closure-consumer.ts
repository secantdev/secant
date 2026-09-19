#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CHECKSUMS_FILE,
  LICENSE_FILE,
  MANIFEST_FILE,
  NOTICES_FILE,
  type CandidateManifest,
  sha256,
} from "./assemble.js";
import {
  INVENTORY_MANIFEST_FILE,
  type ClosureComponent,
  type InventoryManifest,
} from "./inventory.js";
import {
  LAUNCHER_MANIFEST_FILE,
  type LauncherManifest,
} from "./pack-launcher.js";
import { PACKAGE_MANIFEST_FILE, type PackageManifest } from "./pack.js";

// The `release-legal-closure` scenario (spec #137, stories 99/100). It closes the
// two halves the fast declared-dependency check (`checkNoticesCoverage`, which
// stays) cannot: (1) that THIRD-PARTY-NOTICES.md covers the target-specific runtime
// closure actually embedded — the inventory scripts/inventory.ts emitted from the
// real build — naming every shipped component, its shipped version, and its licence
// family; and (2) that the exact source-of-truth legal material is what every one
// of the four consumer channels ships (archive, platform package, launcher package,
// installer result). It runs on the Windows x64, macOS arm64, and Linux x64 matrix
// against the assembled artifacts, never rebuilding an input; the pure verification
// halves are unit-tested in tests/release/ with no subprocess (the Bun 1.4.2
// child-lifecycle defect, #149), and only the archive/tarball extraction round-trip
// on real artifacts is left to the CI job — the way the sibling consumers are.

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
 *  and licence identity is verified per family, not per package, so a per-package
 *  prose mislabel within a covered family is not caught. An unrecognised family
 *  still fails closed. Pure. */
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

/** The legal material a channel staged, as a consumer receives it: the two files
 *  present under `dir` and byte-identical to the source-of-truth digests. Fails on
 *  absent legal material (story 100) or any drift. Pure — no subprocess. */
export function verifyStagedLegal(
  channel: string,
  dir: string,
  truth: SourceOfTruth,
): string[] {
  const problems: string[] = [];
  const licensePath = join(dir, LICENSE_FILE);
  const noticesPath = join(dir, NOTICES_FILE);
  if (!existsSync(licensePath)) {
    problems.push(`${channel} is missing ${LICENSE_FILE}`);
  } else if (sha256(licensePath) !== truth.licenseSha256) {
    problems.push(`${channel} carries an unexpected ${LICENSE_FILE}`);
  }
  if (!existsSync(noticesPath)) {
    problems.push(`${channel} is missing ${NOTICES_FILE}`);
  } else if (sha256(noticesPath) !== truth.noticesSha256) {
    problems.push(`${channel} carries an unexpected ${NOTICES_FILE}`);
  }
  return problems;
}

/** Extract a channel artifact. `gzip` selects the format authoritatively (the
 *  archive's `archiveType`, or `true` for the gzip-compressed npm tarballs) rather
 *  than sniffing the filename, so it cannot drift from the target manifest. */
function extract(archivePath: string, gzip: boolean, into: string): void {
  const [command, args]: [string, string[]] = gzip
    ? ["tar", ["-xzf", archivePath, "-C", into]]
    : process.platform === "win32"
      ? // bsdtar (shipped in Windows) extracts zip; Windows has no unzip.
        ["tar", ["-xf", archivePath, "-C", into]]
      : ["unzip", ["-q", "-o", archivePath, "-d", into]];
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed to extract ${archivePath} (status ${result.status}): ${result.stderr}`,
    );
  }
}

/** Extract one channel artifact and verify its staged legal material. `inner` is
 *  the sub-directory the artifact lays the files under (npm tarballs use
 *  `package/`; archives use the root). `gzip` is the authoritative format flag. */
function verifyChannelArtifact(
  channel: string,
  artifactPath: string,
  gzip: boolean,
  inner: string,
  truth: SourceOfTruth,
): string[] {
  if (!existsSync(artifactPath)) {
    return [`${channel} artifact is missing: ${artifactPath}`];
  }
  const dir = mkdtempSync(join(tmpdir(), "secant-legal-closure-"));
  try {
    extract(artifactPath, gzip, dir);
    return verifyStagedLegal(channel, join(dir, inner), truth);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function verifyReleaseLegalClosure(options: {
  projectRoot: string;
  releaseDir: string;
  packagesDir: string;
}): void {
  const { projectRoot, releaseDir, packagesDir } = options;
  const problems: string[] = [];

  // Source of truth: the repository's legal files, whose coverage of the closure
  // this gate verifies. They must be the exact bytes the assembled candidate is
  // anchored to, so the coverage-checked notices are provably what ships.
  const truth: SourceOfTruth = {
    licenseSha256: sha256(join(projectRoot, LICENSE_FILE)),
    noticesSha256: sha256(join(projectRoot, NOTICES_FILE)),
  };
  const candidate: CandidateManifest = JSON.parse(
    readFileSync(join(releaseDir, MANIFEST_FILE), "utf8"),
  );
  if (
    candidate.licenseSha256 !== truth.licenseSha256 ||
    candidate.noticesSha256 !== truth.noticesSha256
  ) {
    problems.push(
      "The assembled candidate's legal material does not match the repository source of truth this gate verified coverage against.",
    );
  }

  // (1) Notices cover the target-specific embedded runtime closure.
  const inventory: InventoryManifest = JSON.parse(
    readFileSync(join(releaseDir, INVENTORY_MANIFEST_FILE), "utf8"),
  );
  const notices = readFileSync(join(projectRoot, NOTICES_FILE), "utf8");
  problems.push(...verifyClosureNotices(inventory.union, notices));

  // (2) Every consumer channel ships the exact source-of-truth legal material.
  // Archives (extracted at the root) and, transitively, the installer results,
  // which stage the archive's verified legal bytes (install.sh /
  // powershell-installer-consumer.ps1 verify them against the same digests).
  for (const target of candidate.targets) {
    problems.push(
      ...verifyChannelArtifact(
        `Release archive ${target.archive}`,
        join(releaseDir, target.archive),
        target.archiveType === "tar.gz",
        ".",
        truth,
      ),
    );
  }
  // Platform packages and the launcher package (gzip npm tarballs, files under
  // package/).
  const packages: PackageManifest = JSON.parse(
    readFileSync(join(packagesDir, PACKAGE_MANIFEST_FILE), "utf8"),
  );
  for (const pkg of packages.packages) {
    problems.push(
      ...verifyChannelArtifact(
        `Platform package ${pkg.package}`,
        join(packagesDir, pkg.tarball),
        true,
        "package",
        truth,
      ),
    );
  }
  const launcher: LauncherManifest = JSON.parse(
    readFileSync(join(packagesDir, LAUNCHER_MANIFEST_FILE), "utf8"),
  );
  problems.push(
    ...verifyChannelArtifact(
      "Launcher package @secantdev/secant",
      join(packagesDir, launcher.tarball),
      true,
      "package",
      truth,
    ),
  );

  if (problems.length > 0) {
    throw new Error(
      `Release legal-closure verification failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  // Touch CHECKSUMS_FILE existence so a corrupt candidate dir is caught early.
  if (!existsSync(join(releaseDir, CHECKSUMS_FILE))) {
    throw new Error(
      `${CHECKSUMS_FILE} is missing beside the candidate manifest.`,
    );
  }
}

if (import.meta.main) {
  const releaseDir = process.argv[2];
  const packagesDir = process.argv[3];
  if (releaseDir === undefined || packagesDir === undefined) {
    throw new Error(
      "Usage: bun scripts/release-legal-closure-consumer.ts <release-dir> <packages-dir>",
    );
  }
  const projectRoot = resolve(import.meta.dir, "..");
  verifyReleaseLegalClosure({
    projectRoot,
    releaseDir: resolve(releaseDir),
    packagesDir: resolve(packagesDir),
  });
  console.log(
    "Release legal closure verified: notices cover the embedded runtime inventory and every channel ships the shipped legal material.",
  );
}
