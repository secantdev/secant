#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LICENSE_FILE, NOTICES_FILE } from "./assemble.js";
import {
  PACKAGE_MANIFEST_FILE,
  type PackageManifest,
  type PlatformPackage,
} from "./pack.js";
import { npmInstall, sha256File } from "./release-helpers.js";

// The `platform-package-consumer` scenario (#151): install one per-platform npm
// package exactly as a consumer receives it — with lifecycle scripts disabled —
// and prove its os/cpu constraint, exact version, contents (executable and legal
// material only), the absence of any lifecycle script, its inner-binary digest
// against the same archive candidate the smoke ran, executable mode, native
// execution and version, and — on macOS — the strict ad-hoc signature (ADR 0030).
// npm is the channel under test, so this consumer drives it directly. Run against
// the matching-OS package on the Windows x64, macOS arm64, and Linux x64 matrix.

/** Verify an installed package directory against the manifest — everything short
 *  of running the binary: exact version and os/cpu (AC1), no lifecycle script and
 *  exactly the executable and legal material (AC2), the inner-binary digest
 *  against the archive candidate (AC3), the shipped legal bytes, and (POSIX) the
 *  executable mode. Pure file inspection with no subprocess, so the deterministic
 *  suite drives it against a hand-staged directory to prove each AC4 refusal turns
 *  red; the `native` run and macOS signature stay in `verifyPlatformPackage`. */
export async function verifyInstalledPackage(
  installedDir: string,
  pkg: PlatformPackage,
  manifest: PackageManifest,
): Promise<void> {
  // Metadata: exact version and os/cpu constraints, and no lifecycle script.
  const installed = JSON.parse(
    readFileSync(join(installedDir, "package.json"), "utf8"),
  );
  if (installed.version !== manifest.version) {
    throw new Error(
      `${pkg.package} reports version ${JSON.stringify(installed.version)} instead of ${JSON.stringify(manifest.version)}.`,
    );
  }
  if (
    !Array.isArray(installed.os) ||
    installed.os.length !== 1 ||
    installed.os[0] !== pkg.os ||
    !Array.isArray(installed.cpu) ||
    installed.cpu.length !== 1 ||
    installed.cpu[0] !== pkg.cpu
  ) {
    throw new Error(
      `${pkg.package} declares os/cpu ${JSON.stringify(installed.os)}/${JSON.stringify(installed.cpu)}, expected ["${pkg.os}"]/["${pkg.cpu}"].`,
    );
  }
  if (installed.scripts !== undefined) {
    throw new Error(
      `${pkg.package} ships a lifecycle script: ${JSON.stringify(installed.scripts)}.`,
    );
  }

  // Layout: exactly the executable, LICENSE, notices, and the package manifest.
  const expected = [
    pkg.executable,
    LICENSE_FILE,
    NOTICES_FILE,
    "package.json",
  ].sort();
  const actual = readdirSync(installedDir).sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, i) => name !== expected[i])
  ) {
    throw new Error(
      `${pkg.package} contents are ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.`,
    );
  }

  // The inner binary is byte-identical to the built archive candidate (AC3).
  const executablePath = join(installedDir, pkg.executable);
  const binarySha256 = await sha256File(executablePath);
  if (binarySha256 !== pkg.binarySha256) {
    throw new Error(
      `${pkg.executable} digest ${binarySha256} does not match the package manifest ${pkg.binarySha256}.`,
    );
  }

  // The bundled legal material is exactly the shipped LICENSE and notices.
  if (
    (await sha256File(join(installedDir, LICENSE_FILE))) !==
    manifest.licenseSha256
  ) {
    throw new Error(`${pkg.package} carries an unexpected ${LICENSE_FILE}.`);
  }
  if (
    (await sha256File(join(installedDir, NOTICES_FILE))) !==
    manifest.noticesSha256
  ) {
    throw new Error(`${pkg.package} carries an unexpected ${NOTICES_FILE}.`);
  }

  // The executable survives the npm install with its executable mode (POSIX only;
  // Windows has no such bit and runs `.exe` regardless).
  if (process.platform !== "win32") {
    if ((statSync(executablePath).mode & 0o111) === 0) {
      throw new Error(`${pkg.executable} is not executable after npm install.`);
    }
  }
}

/** The pre-install refusals and the installed-contents checks are deterministic;
 *  the `bun test` suite exercises them directly. The npm install → run round-trip
 *  needs npm and a real tarball, so it runs only in the three-OS CI job. */
export async function verifyPlatformPackage(options: {
  /** Directory holding the packed tarballs and the package manifest. */
  packagesDir: string;
  /** The target key to verify: windows-x64, darwin-arm64, or linux-x64. */
  target: string;
  /** Install the tarball and run the binary. Off for pre-install refusals only. */
  native?: boolean;
  /** Host to check the package's os/cpu against; defaults to this process. npm's
   *  os/cpu tokens are exactly `process.platform`/`process.arch`. */
  host?: { platform: string; arch: string };
}): Promise<void> {
  const packagesDir = resolve(options.packagesDir);
  const native = options.native ?? true;
  const host = options.host ?? {
    platform: process.platform,
    arch: process.arch,
  };

  const manifestPath = join(packagesDir, PACKAGE_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(`Package manifest not found: ${manifestPath}.`);
  }
  const manifest: PackageManifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  );
  if (!Array.isArray(manifest.packages)) {
    throw new Error(
      `Malformed package manifest at ${packagesDir}: no packages.`,
    );
  }
  const pkg: PlatformPackage | undefined = manifest.packages.find(
    (candidate) => candidate.key === options.target,
  );
  if (pkg === undefined) {
    throw new Error(
      `${options.target} is not a packaged target in ${PACKAGE_MANIFEST_FILE}.`,
    );
  }

  // The delivered tarball is the exact packed candidate.
  const tarballPath = join(packagesDir, pkg.tarball);
  if (!existsSync(tarballPath)) {
    throw new Error(`Package tarball not found: ${tarballPath}.`);
  }
  const tarballSha256 = await sha256File(tarballPath);
  if (tarballSha256 !== pkg.tarballSha256) {
    throw new Error(
      `${pkg.tarball} digest ${tarballSha256} does not match the package manifest ${pkg.tarballSha256}.`,
    );
  }

  // Wrong target: npm would refuse to install a mismatched os/cpu; reject it here
  // with a precise message rather than a raw EBADPLATFORM.
  if (pkg.os !== host.platform || pkg.cpu !== host.arch) {
    throw new Error(
      `${pkg.package} targets ${pkg.os}-${pkg.cpu}, not this host ${host.platform}-${host.arch}.`,
    );
  }

  if (!native) return;

  const installDir = mkdtempSync(join(tmpdir(), "secant-package-consumer-"));
  try {
    // A bare consumer project, then install the tarball with lifecycle scripts
    // disabled — the pnpm/`--ignore-scripts` route (spec #137, US 78).
    writeFileSync(
      join(installDir, "package.json"),
      `${JSON.stringify({ name: "secant-package-consumer", private: true }, null, 2)}\n`,
    );
    const install = npmInstall({ tarballs: [tarballPath], cwd: installDir });
    if (install.error) throw install.error;
    if (install.status !== 0) {
      throw new Error(
        `npm install ${pkg.tarball} exited ${install.status}: ${install.stderr}`,
      );
    }

    const installedDir = join(installDir, "node_modules", pkg.package);
    if (!existsSync(installedDir)) {
      throw new Error(
        `npm did not install ${pkg.package} into ${installedDir}.`,
      );
    }

    await verifyInstalledPackage(installedDir, pkg, manifest);
    const executablePath = join(installedDir, pkg.executable);

    // Apple silicon refuses arm64 code without at least Bun's ad-hoc signature,
    // which has regressed twice (ADR 0030); verify it before running the binary.
    if (process.platform === "darwin" && pkg.os === "darwin") {
      const codesign = spawnSync(
        "codesign",
        ["--verify", "--deep", "--strict", executablePath],
        { encoding: "utf8" },
      );
      if (codesign.error) throw codesign.error;
      if (codesign.status !== 0) {
        throw new Error(
          `codesign rejected ${pkg.executable} (status ${codesign.status}): ${codesign.stderr}`,
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
        `${pkg.executable} --version exited ${versionResult.status}: ${versionResult.stderr}`,
      );
    }
    if (versionResult.stdout !== `${manifest.version}\n`) {
      throw new Error(
        `${pkg.executable} reported version ${JSON.stringify(versionResult.stdout)} instead of ${JSON.stringify(`${manifest.version}\n`)}.`,
      );
    }
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [packagesDir, target] = process.argv.slice(2);
  if (packagesDir === undefined || target === undefined) {
    throw new Error(
      "Usage: bun scripts/package-consumer.ts <packages-dir> <target-key>",
    );
  }
  await verifyPlatformPackage({ packagesDir, target });
  console.log(`Platform package verified: ${target}.`);
}
