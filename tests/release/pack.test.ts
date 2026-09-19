import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  LICENSE_FILE,
  MANIFEST_FILE,
  NOTICES_FILE,
  computeCandidate,
  sha256,
} from "../../scripts/assemble.js";
import {
  PACKAGE_MANIFEST_FILE,
  type PackageManifest,
  assertPackagesAgree,
  computePackages,
  platformPackageJson,
} from "../../scripts/pack.js";
import {
  verifyInstalledPackage,
  verifyPlatformPackage,
} from "../../scripts/package-consumer.js";
import { TARGETS } from "../../scripts/targets.js";
import { makeTempDir } from "../helpers/tempDir.js";

// These tests exercise the pure packing and pre-install verification logic only,
// and spawn NO subprocess. The stage → `bun pm pack` → npm-install → run
// round-trip (npm os/cpu gating, contents, executable mode, native --version,
// macOS ad-hoc signature) is proven end-to-end, on real binaries, by the
// three-OS `platform-package-consumer` CI job (docs/agents/testing.md). It is
// deliberately kept out of `bun test`: spawning `bun pm pack`/`npm` in the
// parallel pool adds a concurrent first-spawn worker that tips over the Bun 1.4.2
// child-lifecycle defect on the CPU-constrained Linux runner (#149).

const VERSION = "9.9.9-test";

/** The npm os token the target manifest's support-matrix os name maps to. */
const NPM_OS: Record<string, string> = {
  windows: "win32",
  macos: "darwin",
  linux: "linux",
};

/** A fake project tree: package.json, legal material, and one stand-in binary per
 *  gated target under dist/, plus the archive candidate manifest assembly would
 *  have emitted (packing reads it as the byte-identity anchor). */
function makeProject(version = VERSION): string {
  const root = makeTempDir("secant-pack-project-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@secantdev/secant", version }, null, 2),
  );
  writeFileSync(join(root, LICENSE_FILE), "Secant test LICENSE\n");
  writeFileSync(join(root, NOTICES_FILE), "Secant test third-party notices\n");
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  for (const [key, target] of Object.entries(TARGETS)) {
    writeFileSync(join(dist, target.outfile), `stand-in binary for ${key}\n`);
  }
  const releaseDir = join(dist, "release");
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(
    join(releaseDir, MANIFEST_FILE),
    JSON.stringify(computeCandidate({ projectRoot: root })),
  );
  return root;
}

test("platformPackageJson carries the exact version, npm os/cpu, contents, and no script", () => {
  for (const target of Object.values(TARGETS)) {
    const json = platformPackageJson(target, VERSION);
    // AC1: exact release version and OS/CPU constraints from the target manifest.
    assert.equal(json.name, target.package);
    assert.equal(json.version, VERSION);
    assert.deepEqual(json.os, [NPM_OS[target.os]]);
    assert.deepEqual(json.cpu, [target.cpu]);
    // AC2: only the executable and legal material, and no lifecycle script.
    assert.deepEqual(json.files, [
      target.executable,
      LICENSE_FILE,
      NOTICES_FILE,
    ]);
    assert.equal(json.scripts, undefined);
    assert.equal(json.dependencies, undefined);
  }
});

test("computePackages carries every target and matches the archive candidate bytes", () => {
  const root = makeProject();
  const { manifest, packageJson } = computePackages({ projectRoot: root });
  const candidate = computeCandidate({ projectRoot: root });

  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.packages.length, Object.keys(TARGETS).length);

  for (const [key, target] of Object.entries(TARGETS)) {
    const pkg = manifest.packages.find((p) => p.key === key);
    assert.ok(pkg, `manifest is missing target ${key}`);
    assert.equal(pkg.package, target.package);
    assert.equal(pkg.os, NPM_OS[target.os]);
    assert.equal(pkg.cpu, target.cpu);
    assert.equal(pkg.executable, target.executable);
    // AC3: the packed binary digest equals the archive candidate's.
    const archive = candidate.targets.find((t) => t.key === key);
    assert.ok(archive);
    assert.equal(pkg.binarySha256, archive.binarySha256);
    assert.equal(packageJson[key].version, VERSION);
  }
});

test("computePackages fails closed without the archive candidate manifest", () => {
  const root = makeProject();
  rmSync(join(root, "dist", "release", MANIFEST_FILE));
  assert.throws(
    () => computePackages({ projectRoot: root }),
    /Archive candidate manifest missing/,
  );
});

test("computePackages fails closed when a dist binary differs from the candidate", () => {
  const root = makeProject();
  // Rebuild-under-an-assembled-candidate: the candidate manifest is fixed, but a
  // dist binary now differs. Packing must never carry a non-candidate byte.
  appendFileSync(join(root, "dist", TARGETS["linux-x64"].outfile), "rebuilt");
  assert.throws(
    () => computePackages({ projectRoot: root }),
    /binary digest disagreement/,
  );
});

test("computePackages fails closed on legal-material drift", () => {
  const root = makeProject();
  appendFileSync(join(root, LICENSE_FILE), "tampered");
  assert.throws(
    () => computePackages({ projectRoot: root }),
    /Legal-material digest disagreement/,
  );
});

test("assertPackagesAgree rejects version, identity, and binary-digest disagreement", () => {
  const base = computePackages({ projectRoot: makeProject() }).manifest;
  const clone = (): PackageManifest =>
    JSON.parse(JSON.stringify(base)) as PackageManifest;

  assert.doesNotThrow(() => assertPackagesAgree(base, clone()));

  const bumped = clone();
  (bumped as { version: string }).version = "9.9.10-test";
  assert.throws(
    () => assertPackagesAgree(base, bumped),
    /version disagreement/,
  );

  const rebuilt = clone();
  (rebuilt.packages[0] as { binarySha256: string }).binarySha256 = "0".repeat(
    64,
  );
  assert.throws(
    () => assertPackagesAgree(base, rebuilt),
    /binary digest disagreement/,
  );

  const renamed = clone();
  (renamed.packages[0] as { executable: string }).executable = "renamed";
  assert.throws(
    () => assertPackagesAgree(base, renamed),
    /identity disagreement/,
  );

  const dropped = clone();
  dropped.packages.pop();
  assert.throws(
    () => assertPackagesAgree(base, dropped),
    /identity disagreement/,
  );
});

/** A packages directory holding one target's manifest and a stand-in tarball whose
 *  digest matches it. No real tarball is packed. */
function makePackagesDir(): {
  dir: string;
  target: string;
  tarballPath: string;
  npmOs: string;
  npmCpu: string;
} {
  const manifest = computePackages({ projectRoot: makeProject() }).manifest;
  const dir = makeTempDir("secant-packages-dir-");
  const pkg = manifest.packages.find((p) => p.key === "linux-x64");
  assert.ok(pkg);
  pkg.tarball = "secantdev-secant-linux-x64-9.9.9-test.tgz";
  const tarballPath = join(dir, pkg.tarball);
  writeFileSync(tarballPath, "stand-in tarball bytes");
  pkg.tarballSha256 = sha256(tarballPath);
  writeFileSync(join(dir, PACKAGE_MANIFEST_FILE), JSON.stringify(manifest));
  return {
    dir,
    target: "linux-x64",
    tarballPath,
    npmOs: pkg.os,
    npmCpu: pkg.cpu,
  };
}

test("the consumer accepts a matching-host package before install", () => {
  const { dir, target, npmOs, npmCpu } = makePackagesDir();
  assert.doesNotThrow(() =>
    verifyPlatformPackage({
      packagesDir: dir,
      target,
      native: false,
      host: { platform: npmOs, arch: npmCpu },
    }),
  );
});

test("the consumer refuses a package built for another target", () => {
  const { dir, target } = makePackagesDir();
  // AC4: reject the wrong target — the linux-x64 package on a darwin/arm64 host.
  assert.throws(
    () =>
      verifyPlatformPackage({
        packagesDir: dir,
        target,
        native: false,
        host: { platform: "darwin", arch: "arm64" },
      }),
    /not this host/,
  );
});

test("the consumer refuses an unknown target", () => {
  const { dir, npmOs, npmCpu } = makePackagesDir();
  assert.throws(
    () =>
      verifyPlatformPackage({
        packagesDir: dir,
        target: "solaris-sparc",
        native: false,
        host: { platform: npmOs, arch: npmCpu },
      }),
    /is not a packaged target/,
  );
});

test("the consumer refuses a tampered tarball digest", () => {
  const { dir, target, tarballPath, npmOs, npmCpu } = makePackagesDir();
  appendFileSync(tarballPath, "tamper");
  assert.throws(
    () =>
      verifyPlatformPackage({
        packagesDir: dir,
        target,
        native: false,
        host: { platform: npmOs, arch: npmCpu },
      }),
    /does not match the package manifest/,
  );
});

test("the consumer requires the package manifest", () => {
  const { dir, target, npmOs, npmCpu } = makePackagesDir();
  rmSync(join(dir, PACKAGE_MANIFEST_FILE));
  assert.throws(
    () =>
      verifyPlatformPackage({
        packagesDir: dir,
        target,
        native: false,
        host: { platform: npmOs, arch: npmCpu },
      }),
    /Package manifest not found/,
  );
});

test("the consumer refuses a malformed manifest", () => {
  const { dir, target, npmOs, npmCpu } = makePackagesDir();
  writeFileSync(join(dir, PACKAGE_MANIFEST_FILE), "{}");
  assert.throws(
    () =>
      verifyPlatformPackage({
        packagesDir: dir,
        target,
        native: false,
        host: { platform: npmOs, arch: npmCpu },
      }),
    /Malformed package manifest/,
  );
});

/** Stage a correct installed package directory (as npm would leave it) from a fake
 *  project's dist binary and legal material, so the deterministic suite can drive
 *  the post-install refusals that the CI round-trip otherwise never triggers. */
function stageInstalledDir(): {
  installedDir: string;
  pkg: PackageManifest["packages"][number];
  manifest: PackageManifest;
} {
  const root = makeProject();
  const manifest = computePackages({ projectRoot: root }).manifest;
  const pkg = manifest.packages.find((p) => p.key === "linux-x64");
  assert.ok(pkg);
  pkg.tarball = "secantdev-secant-linux-x64-9.9.9-test.tgz";
  const installedDir = makeTempDir("secant-installed-");
  const target = TARGETS[pkg.key];
  copyFileSync(
    join(root, "dist", target.outfile),
    join(installedDir, pkg.executable),
  );
  chmodSync(join(installedDir, pkg.executable), 0o755);
  copyFileSync(join(root, LICENSE_FILE), join(installedDir, LICENSE_FILE));
  copyFileSync(join(root, NOTICES_FILE), join(installedDir, NOTICES_FILE));
  writeFileSync(
    join(installedDir, "package.json"),
    JSON.stringify(platformPackageJson(target, manifest.version)),
  );
  return { installedDir, pkg, manifest };
}

test("verifyInstalledPackage accepts a correctly installed package", () => {
  const { installedDir, pkg, manifest } = stageInstalledDir();
  assert.doesNotThrow(() =>
    verifyInstalledPackage(installedDir, pkg, manifest),
  );
});

test("verifyInstalledPackage rejects a stale version", () => {
  const { installedDir, pkg, manifest } = stageInstalledDir();
  const json = JSON.parse(
    readFileSync(join(installedDir, "package.json"), "utf8"),
  );
  json.version = "0.0.0-stale";
  writeFileSync(join(installedDir, "package.json"), JSON.stringify(json));
  assert.throws(
    () => verifyInstalledPackage(installedDir, pkg, manifest),
    /reports version/,
  );
});

test("verifyInstalledPackage rejects a lifecycle script", () => {
  const { installedDir, pkg, manifest } = stageInstalledDir();
  const json = platformPackageJson(TARGETS[pkg.key], manifest.version);
  (json as { scripts: unknown }).scripts = { postinstall: "node evil.js" };
  writeFileSync(join(installedDir, "package.json"), JSON.stringify(json));
  assert.throws(
    () => verifyInstalledPackage(installedDir, pkg, manifest),
    /lifecycle script/,
  );
});

test("verifyInstalledPackage rejects an unexpected file", () => {
  const { installedDir, pkg, manifest } = stageInstalledDir();
  writeFileSync(join(installedDir, "stowaway.txt"), "unexpected");
  assert.throws(
    () => verifyInstalledPackage(installedDir, pkg, manifest),
    /contents are/,
  );
});

test("verifyInstalledPackage rejects a missing legal file", () => {
  const { installedDir, pkg, manifest } = stageInstalledDir();
  rmSync(join(installedDir, NOTICES_FILE));
  assert.throws(
    () => verifyInstalledPackage(installedDir, pkg, manifest),
    /contents are/,
  );
});

test("verifyInstalledPackage rejects tampered legal bytes", () => {
  const { installedDir, pkg, manifest } = stageInstalledDir();
  appendFileSync(join(installedDir, LICENSE_FILE), "tampered");
  assert.throws(
    () => verifyInstalledPackage(installedDir, pkg, manifest),
    new RegExp(`unexpected ${LICENSE_FILE}`),
  );
});

test("verifyInstalledPackage rejects an inner-binary digest mismatch", () => {
  const { installedDir, pkg, manifest } = stageInstalledDir();
  appendFileSync(join(installedDir, pkg.executable), "rebuilt");
  assert.throws(
    () => verifyInstalledPackage(installedDir, pkg, manifest),
    /does not match the package manifest/,
  );
});

test(
  "verifyInstalledPackage rejects a non-executable binary",
  { skip: process.platform === "win32" },
  () => {
    const { installedDir, pkg, manifest } = stageInstalledDir();
    chmodSync(join(installedDir, pkg.executable), 0o644);
    assert.throws(
      () => verifyInstalledPackage(installedDir, pkg, manifest),
      /not executable/,
    );
  },
);
