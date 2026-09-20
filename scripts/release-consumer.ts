#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  CHECKSUMS_FILE,
  LICENSE_FILE,
  MANIFEST_FILE,
  NOTICES_FILE,
  type CandidateManifest,
  type CandidateTarget,
} from "./assemble.js";
import { sha256File } from "./release-helpers.js";

// The `release-archive-consumer` scenario (#150): extract one final release
// archive exactly as a consumer receives it and prove its layout, executable
// mode, inner-binary digest, bundled legal material, native execution and
// version, and — on macOS — the strict ad-hoc signature (ADR 0030). It reads the
// candidate manifest that assembly emitted beside the archive, so every check is
// anchored to the same bytes the compiled-binary smoke ran. Run against the
// matching-OS archive on the Windows x64, macOS arm64, and Linux x64 matrix.

function extract(archivePath: string, type: string, into: string): void {
  const [command, args]: [string, string[]] =
    type === "tar.gz"
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

export async function verifyReleaseArchive(options: {
  archive: string;
  manifestDir?: string;
  /** Run the extracted binary (`--version`) and verify the macOS signature.
   *  Only valid when the archive targets this host; the CI matrix guarantees it. */
  native?: boolean;
}): Promise<void> {
  const archivePath = resolve(options.archive);
  if (!existsSync(archivePath)) {
    throw new Error(`Release archive not found: ${archivePath}.`);
  }
  const native = options.native ?? true;
  const manifestDir = options.manifestDir ?? resolve(archivePath, "..");

  const manifest: CandidateManifest = JSON.parse(
    readFileSync(join(manifestDir, MANIFEST_FILE), "utf8"),
  );
  if (!Array.isArray(manifest.targets)) {
    throw new Error(
      `Malformed candidate manifest at ${manifestDir}: no targets.`,
    );
  }
  const target: CandidateTarget | undefined = manifest.targets.find(
    (candidate) => candidate.archive === basename(archivePath),
  );
  if (target === undefined) {
    throw new Error(
      `${basename(archivePath)} is not a candidate archive in ${MANIFEST_FILE}.`,
    );
  }

  // The archive is the exact assembled candidate (its own digest, cross-checked
  // against the emitted SHA256SUMS).
  const archiveSha256 = await sha256File(archivePath);
  if (archiveSha256 !== target.archiveSha256) {
    throw new Error(
      `${target.archive} digest ${archiveSha256} does not match the candidate manifest ${target.archiveSha256}.`,
    );
  }
  const checksumsPath = join(manifestDir, CHECKSUMS_FILE);
  if (!existsSync(checksumsPath)) {
    throw new Error(
      `${CHECKSUMS_FILE} is missing beside the candidate manifest.`,
    );
  }
  const line = `${archiveSha256}  ${target.archive}`;
  if (!readFileSync(checksumsPath, "utf8").split("\n").includes(line)) {
    throw new Error(`${target.archive} is not listed in ${CHECKSUMS_FILE}.`);
  }

  const extractDir = mkdtempSync(join(tmpdir(), "secant-release-consumer-"));
  try {
    extract(archivePath, target.archiveType, extractDir);

    // Layout: exactly the executable, LICENSE, and third-party notices.
    const expected = [target.executable, LICENSE_FILE, NOTICES_FILE].sort();
    const actual = readdirSync(extractDir).sort();
    if (
      actual.length !== expected.length ||
      actual.some((name, i) => name !== expected[i])
    ) {
      throw new Error(
        `${target.archive} layout is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.`,
      );
    }

    // The inner binary is byte-identical to the built candidate.
    const executablePath = join(extractDir, target.executable);
    const binarySha256 = await sha256File(executablePath);
    if (binarySha256 !== target.binarySha256) {
      throw new Error(
        `${target.executable} digest ${binarySha256} does not match the candidate manifest ${target.binarySha256}.`,
      );
    }

    // The bundled legal material is exactly the shipped LICENSE and notices.
    if (
      (await sha256File(join(extractDir, LICENSE_FILE))) !==
      manifest.licenseSha256
    ) {
      throw new Error(
        `${target.archive} carries an unexpected ${LICENSE_FILE}.`,
      );
    }
    if (
      (await sha256File(join(extractDir, NOTICES_FILE))) !==
      manifest.noticesSha256
    ) {
      throw new Error(
        `${target.archive} carries an unexpected ${NOTICES_FILE}.`,
      );
    }

    // The executable survives extraction with its executable mode (POSIX only;
    // Windows has no such bit and runs `.exe` regardless).
    if (process.platform !== "win32") {
      if ((statSync(executablePath).mode & 0o111) === 0) {
        throw new Error(
          `${target.executable} is not executable after extraction.`,
        );
      }
    }

    if (!native) return;

    // Apple silicon refuses arm64 code without at least Bun's ad-hoc signature,
    // which has regressed twice (ADR 0030); verify it before running the binary.
    if (process.platform === "darwin" && target.os === "macos") {
      const codesign = spawnSync(
        "codesign",
        ["--verify", "--deep", "--strict", executablePath],
        { encoding: "utf8" },
      );
      if (codesign.error) throw codesign.error;
      if (codesign.status !== 0) {
        throw new Error(
          `codesign rejected ${target.executable} (status ${codesign.status}): ${codesign.stderr}`,
        );
      }
    }

    // Native execution and the embedded version.
    const versionResult = spawnSync(executablePath, ["--version"], {
      encoding: "utf8",
    });
    if (versionResult.error) throw versionResult.error;
    if (versionResult.status !== 0) {
      throw new Error(
        `${target.executable} --version exited ${versionResult.status}: ${versionResult.stderr}`,
      );
    }
    if (versionResult.stdout !== `${manifest.version}\n`) {
      throw new Error(
        `${target.executable} reported version ${JSON.stringify(versionResult.stdout)} instead of ${JSON.stringify(`${manifest.version}\n`)}.`,
      );
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const archive = process.argv[2];
  if (archive === undefined) {
    throw new Error(
      "Usage: bun scripts/release-consumer.ts <archive> [manifest-dir]",
    );
  }
  await verifyReleaseArchive({ archive, manifestDir: process.argv[3] });
  console.log(`Release archive verified: ${basename(resolve(archive))}.`);
}
