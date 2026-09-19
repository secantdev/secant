import assert from "node:assert/strict";
import test from "node:test";
import { dryRunPlan } from "../../scripts/npm-dry-run.js";

// The candidate archive/package manifests carry per-target packages and a launcher,
// each with the tarball `bun pm pack` named (scripts/pack.ts, scripts/pack-launcher.ts).
const packageManifest = {
  version: "1.2.3",
  packages: [
    {
      key: "windows-x64",
      package: "@secantdev/secant-windows-x64",
      tarball: "win.tgz",
    },
    {
      key: "darwin-arm64",
      package: "@secantdev/secant-darwin-arm64",
      tarball: "mac.tgz",
    },
    {
      key: "linux-x64",
      package: "@secantdev/secant-linux-x64",
      tarball: "linux.tgz",
    },
  ],
};
const launcherManifest = {
  version: "1.2.3",
  package: "@secantdev/secant",
  tarball: "launcher.tgz",
};

test("the plan dry-runs every platform package before the launcher", () => {
  const plan = dryRunPlan(packageManifest, launcherManifest);
  assert.deepEqual(
    plan.map((step) => step.package),
    [
      "@secantdev/secant-windows-x64",
      "@secantdev/secant-darwin-arm64",
      "@secantdev/secant-linux-x64",
      "@secantdev/secant",
    ],
  );
  // The launcher is strictly last: it advertises the platform packages as optional
  // dependencies, so they must clear their own dry-run first (spec #137, story 88).
  assert.equal(plan.at(-1)!.package, "@secantdev/secant");
  assert.deepEqual(
    plan.map((step) => step.tarball),
    ["win.tgz", "mac.tgz", "linux.tgz", "launcher.tgz"],
  );
});

test("a package manifest with no packages fails closed", () => {
  assert.throws(
    () => dryRunPlan({ version: "1.2.3", packages: [] }, launcherManifest),
    /package-manifest\.packages/,
  );
  assert.throws(
    () => dryRunPlan({ version: "1.2.3" }, launcherManifest),
    /package-manifest\.packages/,
  );
});

test("a package missing its tarball fails closed", () => {
  assert.throws(
    () =>
      dryRunPlan(
        { packages: [{ package: "@secantdev/secant-linux-x64" }] },
        launcherManifest,
      ),
    /packages\[0\]\.tarball/,
  );
});

test("a launcher manifest missing its tarball fails closed", () => {
  assert.throws(
    () => dryRunPlan(packageManifest, { package: "@secantdev/secant" }),
    /launcher-manifest\.tarball/,
  );
});

test("a non-object manifest fails closed", () => {
  assert.throws(() => dryRunPlan(null, launcherManifest), /package-manifest/);
  assert.throws(() => dryRunPlan(packageManifest, "nope"), /launcher-manifest/);
});
