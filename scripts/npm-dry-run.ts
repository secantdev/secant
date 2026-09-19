#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_MANIFEST_FILE } from "./pack.js";
import { LAUNCHER_MANIFEST_FILE } from "./pack-launcher.js";

// The authenticated npm dry-run of the candidate-validation scenario (#157, spec
// #137 stories 85/89): a separately configured read-only npm identity authenticates
// (`npm whoami`) and publish-dry-runs every platform package first and the launcher
// last, against the one assembled candidate set. `--dry-run` performs every publish
// step except the upload, and the read-only identity cannot publish regardless, so
// the machinery is proven end to end without any route to publication.
//
// Package-before-launcher order is load-bearing: real publication publishes the
// platform packages first so the launcher never advertises an optional dependency
// that failed its own dry-run (spec #137, story 88). The dry-run rehearses that
// order. The ORDERING and tarball-selection logic is pure (`dryRunPlan`) and unit
// tested in tests/release/npm-dry-run.test.ts; only the real `npm` round-trip runs
// in the CI job — the way the sibling consumers keep their subprocess out of `bun
// test` (the Bun 1.4.2 child-lifecycle defect, #149).

export interface DryRunStep {
  /** The npm package name, for the log line. */
  readonly package: string;
  /** The packed tarball filename, as `bun pm pack` named it, resolved in the
   *  packages directory. */
  readonly tarball: string;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid npm dry-run manifest field: ${field}.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid npm dry-run manifest field: ${field}.`);
  }
  return value;
}

/** The ordered publish-dry-run plan for the packed candidate: every platform
 *  package from the package manifest in its own order, then the launcher last.
 *  Fails closed on a manifest missing any field the plan needs. Pure, so it is
 *  exercised without spawning npm. */
export function dryRunPlan(
  packageManifest: unknown,
  launcherManifest: unknown,
): DryRunStep[] {
  const manifest = record(packageManifest, "package-manifest");
  const packages = manifest.packages;
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error(
      "Invalid npm dry-run manifest field: package-manifest.packages.",
    );
  }
  const steps: DryRunStep[] = packages.map((entry, index) => {
    const pkg = record(entry, `package-manifest.packages[${index}]`);
    return {
      package: text(pkg.package, `package-manifest.packages[${index}].package`),
      tarball: text(pkg.tarball, `package-manifest.packages[${index}].tarball`),
    };
  });
  const launcher = record(launcherManifest, "launcher-manifest");
  steps.push({
    package: text(launcher.package, "launcher-manifest.package"),
    tarball: text(launcher.tarball, "launcher-manifest.tarball"),
  });
  return steps;
}

function readManifest(path: string): unknown {
  if (!existsSync(path)) {
    throw new Error(
      `Package manifest missing: ${path}. Run \`bun run scripts/pack.ts\` and \`bun run scripts/pack-launcher.ts\` first; the dry-run rehearses the packed candidate, never a rebuild.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Run npm in the packages directory and fail closed on a non-zero exit. This job
 *  runs on Linux only, so `npm` launches directly (no Windows `.cmd`-shim dance). */
function runNpm(args: string[], cwd: string): void {
  const result = spawnSync("npm", args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed (status ${result.status}).`);
  }
}

async function main(): Promise<void> {
  const packagesDir = process.argv[2];
  if (!packagesDir) {
    throw new Error("Usage: bun scripts/npm-dry-run.ts <packages-dir>");
  }
  const plan = dryRunPlan(
    readManifest(join(packagesDir, PACKAGE_MANIFEST_FILE)),
    readManifest(join(packagesDir, LAUNCHER_MANIFEST_FILE)),
  );
  // Authenticate the read-only identity before any dry-run; a bad or missing
  // credential fails safely here rather than midway through the plan.
  runNpm(["whoami"], packagesDir);
  for (const step of plan) {
    console.log(`Dry-running ${step.package} (${step.tarball})`);
    runNpm(["publish", step.tarball, "--dry-run"], packagesDir);
  }
  console.log(`Dry-ran ${plan.length} packages without publishing.`);
}

if (import.meta.main) {
  await main();
}
