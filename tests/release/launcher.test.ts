import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveExecutable, selectTarget } from "../../bin/secant.mjs";
import { LICENSE_FILE, NOTICES_FILE } from "../../scripts/assemble.js";
import {
  LAUNCHER_FILE,
  LAUNCHER_PLATFORMS_FILE,
  launcherPackageJson,
  launcherPlatforms,
} from "../../scripts/pack-launcher.js";
import { TARGETS } from "../../scripts/targets.js";

// The launcher's pure resolution logic and the launcher-package staging shape, with
// NO subprocess. The npm/pnpm install → launch → Proof Bundle round-trip on real
// binaries is proven end-to-end, on the three-OS matrix, by the `npm-launcher-consumer`
// CI job (scripts/launcher-consumer.ts, docs/agents/testing.md) — deliberately kept
// out of `bun test` for the Bun 1.4.2 child-lifecycle reason (#149).

const VERSION = "9.9.9-test";

/** The npm os token each support-matrix os maps to (also the `process.platform`). */
const NPM_OS: Record<string, string> = {
  windows: "win32",
  macos: "darwin",
  linux: "linux",
};

test("launcherPlatforms maps every target by its npm platform-arch key", () => {
  const platforms = launcherPlatforms();
  assert.equal(Object.keys(platforms).length, Object.keys(TARGETS).length);
  for (const target of Object.values(TARGETS)) {
    const key = `${NPM_OS[target.os]}-${target.cpu}`;
    assert.deepEqual(platforms[key], {
      package: target.package,
      executable: target.executable,
    });
  }
});

test("launcherPackageJson pins exact optional deps, ships legal + launcher, no script/os/cpu", () => {
  const json = launcherPackageJson(VERSION);
  assert.equal(json.name, "@secantdev/secant");
  assert.equal(json.version, VERSION);
  assert.equal(json.type, "module");
  assert.deepEqual(json.bin, { secant: `./${LAUNCHER_FILE}` });
  // AC5: legal material and the launcher only — no candidate executable.
  assert.deepEqual(json.files, [
    LAUNCHER_FILE,
    LAUNCHER_PLATFORMS_FILE,
    LICENSE_FILE,
    NOTICES_FILE,
  ]);
  // AC1: exact-version optional dependencies on every platform package.
  const optional = json.optionalDependencies as Record<string, string>;
  assert.equal(Object.keys(optional).length, Object.keys(TARGETS).length);
  for (const target of Object.values(TARGETS)) {
    assert.equal(optional[target.package], VERSION);
  }
  // AC1/AC2: no lifecycle script; the launcher must install everywhere, so no os/cpu.
  assert.equal(json.scripts, undefined);
  assert.equal(json.os, undefined);
  assert.equal(json.cpu, undefined);
  assert.equal(json.dependencies, undefined);
});

test("selectTarget returns the matching package for a supported host", () => {
  const platforms = launcherPlatforms();
  const target = TARGETS["linux-x64"];
  assert.deepEqual(selectTarget(platforms, "linux", "x64"), {
    key: "linux-x64",
    package: target.package,
    executable: target.executable,
  });
});

test("selectTarget refuses an unsupported host, naming the supported platforms", () => {
  const platforms = launcherPlatforms();
  assert.throws(
    () => selectTarget(platforms, "sunos", "sparc"),
    (error: Error) =>
      /does not ship a binary for sunos-sparc/.test(error.message) &&
      error.message.includes("darwin-arm64") &&
      error.message.includes("linux-x64") &&
      error.message.includes("win32-x64"),
  );
});

test("resolveExecutable joins the resolved package directory with its executable", () => {
  const platforms = launcherPlatforms();
  const packageJsonPath = join(
    "/tmp",
    "consumer",
    "node_modules",
    "@secantdev",
    "secant-darwin-arm64",
    "package.json",
  );
  const resolved = resolveExecutable({
    platforms,
    platform: "darwin",
    arch: "arm64",
    resolvePackageJson: () => packageJsonPath,
  });
  assert.equal(
    resolved,
    join(dirname(packageJsonPath), TARGETS["darwin-arm64"].executable),
  );
});

test("resolveExecutable reports a missing optional package before spawn", () => {
  const platforms = launcherPlatforms();
  assert.throws(
    () =>
      resolveExecutable({
        platforms,
        platform: "win32",
        arch: "x64",
        resolvePackageJson: () => {
          // How `require.resolve` reports an uninstalled package.
          const error = new Error("Cannot find module") as Error & {
            code: string;
          };
          error.code = "MODULE_NOT_FOUND";
          throw error;
        },
      }),
    (error: Error) =>
      /is not installed/.test(error.message) &&
      error.message.includes(TARGETS["windows-x64"].package),
  );
});

test("resolveExecutable surfaces a non-missing resolution failure with its cause", () => {
  const platforms = launcherPlatforms();
  const underlying = new Error("EACCES: permission denied");
  assert.throws(
    () =>
      resolveExecutable({
        platforms,
        platform: "linux",
        arch: "x64",
        resolvePackageJson: () => {
          throw underlying;
        },
      }),
    (error: Error & { cause?: unknown }) =>
      /Could not resolve/.test(error.message) &&
      !/is not installed/.test(error.message) &&
      error.message.includes("EACCES: permission denied") &&
      error.cause === underlying,
  );
});

test("the launcher reads its platform map from LAUNCHER_PLATFORMS_FILE", () => {
  // bin/secant.mjs cannot import scripts/pack-launcher.ts (it must stay pure Node),
  // so it hardcodes the map filename. Fail fast here if the two drift apart, rather
  // than only in the three-OS CI job (where every real install would already break).
  const launcherSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../bin/secant.mjs"),
    "utf8",
  );
  assert.ok(
    launcherSource.includes(`"${LAUNCHER_PLATFORMS_FILE}"`),
    `bin/secant.mjs must read "${LAUNCHER_PLATFORMS_FILE}" (the name scripts/pack-launcher.ts writes).`,
  );
});
