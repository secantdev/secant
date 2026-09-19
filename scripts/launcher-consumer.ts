#!/usr/bin/env bun
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import which from "which";
import { installReplayerAt } from "../tests/harness/replayer-install.js";
import { seedTestRepairWorkspace } from "../tests/helpers/testRepairWorkspace.js";
import { PACKAGE_MANIFEST_FILE, type PackageManifest } from "./pack.js";
import {
  LAUNCHER_FILE,
  LAUNCHER_MANIFEST_FILE,
  type LauncherManifest,
} from "./pack-launcher.js";
import { hostTargetKey } from "./targets.js";

// The `npm-launcher-consumer` scenario (#152). It proves the thin, script-free npm
// launcher (@secantdev/secant, spec #137) as a consumer receives it: installed with
// lifecycle scripts disabled, resolving the matching per-platform package IN PLACE
// under both an npm-flat and a pnpm-symlinked layout, forwarding arguments, stdio,
// and the native exit status, failing before spawn with an actionable diagnostic
// when the optional package is absent, and completing the Proof Bundle smoke — the
// M3 gate — end to end THROUGH the launched command (spec #137 Release boundary).
// npm is the channel under test, so this consumer drives it directly. Run against
// the matching-OS packages on the Windows x64, macOS arm64, and Linux x64 matrix;
// kept out of `bun test` (the Bun 1.4.2 child-lifecycle defect, #149).

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// This script runs under Bun; the launcher runs under Node (ADR 0030: Node of any
// version is needed only to run npm and the shim). The runtime dir goes on the
// Proof Bundle env's PATH so the recorded replayer's shim can spawn it, exactly as
// the compiled-binary smoke does.
const runtimeDir = dirname(process.execPath);

/** Install one or more local tarballs with lifecycle scripts disabled, never
 *  routing a Windows `.cmd` through cmd.exe — Node on `npm-cli.js` beside the
 *  resolved `npm` shim on Windows, the `npm` launcher directly on POSIX (#21;
 *  mirrors scripts/package-consumer.ts). `--omit=optional` keeps the install
 *  network-free: the launcher's optional dependencies are the unpublished platform
 *  packages, and the matching one is supplied as an explicit tarball instead. */
function npmInstall(
  tarballs: readonly string[],
  cwd: string,
): SpawnSyncReturns<string> {
  const args = [
    "install",
    ...tarballs,
    "--ignore-scripts",
    "--omit=optional",
    "--no-save",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
  ];
  if (process.platform !== "win32") {
    return spawnSync("npm", args, { cwd, encoding: "utf8" });
  }
  const npmShim = which.sync("npm");
  const npmCli = join(
    dirname(npmShim),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!existsSync(npmCli)) {
    throw new Error(
      `npm CLI not found beside ${npmShim} (looked for ${npmCli}).`,
    );
  }
  return spawnSync("node", [npmCli, ...args], { cwd, encoding: "utf8" });
}

/** Run the launcher entry under Node with captured output. */
function launch(
  launcherEntry: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): SpawnSyncReturns<string> {
  return spawnSync("node", [launcherEntry, ...args], {
    encoding: "utf8",
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
}

/** Prove the launcher forwards to the real candidate under a resolved layout: the
 *  embedded version prints exactly, `--help` identifies secant, and an unknown
 *  command's non-zero exit status is preserved. */
function assertForwards(
  launcherEntry: string,
  version: string,
  label: string,
): void {
  const versionResult = launch(launcherEntry, ["--version"]);
  if (versionResult.error) throw versionResult.error;
  if (versionResult.status !== 0 || versionResult.stdout !== `${version}\n`) {
    throw new Error(
      `${label}: launcher --version did not forward to the candidate (status ${versionResult.status}): ${versionResult.stdout}${versionResult.stderr}`,
    );
  }
  const helpResult = launch(launcherEntry, ["--help"]);
  if (helpResult.error) throw helpResult.error;
  if (helpResult.status !== 0 || !helpResult.stdout.includes("Usage: secant")) {
    throw new Error(
      `${label}: launcher --help did not forward: ${helpResult.stdout}${helpResult.stderr}`,
    );
  }
  const unknown = launch(launcherEntry, ["frobnicate"]);
  if (unknown.error) throw unknown.error;
  if (unknown.status === 0) {
    throw new Error(
      `${label}: launcher did not preserve a non-zero exit status for an unknown command.`,
    );
  }
}

/** Copy an npm-installed package directory into a pnpm-shaped layout: the launcher
 *  and its platform package live beside each other under a `.pnpm` store, and the
 *  top-level `node_modules` holds only a symlink to the launcher — the platform
 *  package is NOT hoisted to the top level. Resolving it therefore only works if the
 *  launcher canonicalizes its own path first, which is exactly what pnpm needs. */
function buildPnpmLayout(
  root: string,
  launcherDir: string,
  platformDir: string,
  platformPackage: string,
): string {
  const storeInner = join(
    root,
    "node_modules",
    ".pnpm",
    "@secantdev+secant@store",
    "node_modules",
  );
  const storeLauncher = join(storeInner, "@secantdev", "secant");
  const storePlatform = join(storeInner, platformPackage);
  mkdirSync(dirname(storeLauncher), { recursive: true });
  cpSync(launcherDir, storeLauncher, { recursive: true });
  mkdirSync(dirname(storePlatform), { recursive: true });
  cpSync(platformDir, storePlatform, { recursive: true });
  const topLevel = join(root, "node_modules", "@secantdev", "secant");
  mkdirSync(dirname(topLevel), { recursive: true });
  symlinkSync(
    storeLauncher,
    topLevel,
    process.platform === "win32" ? "junction" : "dir",
  );
  return join(topLevel, LAUNCHER_FILE);
}

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

export function verifyLauncherConsumer(packagesDir: string): void {
  const dir = resolve(packagesDir);
  const packageManifest: PackageManifest = JSON.parse(
    readFileSync(join(dir, PACKAGE_MANIFEST_FILE), "utf8"),
  );
  const launcherManifest: LauncherManifest = JSON.parse(
    readFileSync(join(dir, LAUNCHER_MANIFEST_FILE), "utf8"),
  );
  const version = launcherManifest.version;
  if (packageManifest.version !== version) {
    throw new Error(
      `Manifest version disagreement: launcher ${version}, platform packages ${packageManifest.version}.`,
    );
  }

  const hostKey = hostTargetKey(process.platform, process.arch);
  if (hostKey === undefined) {
    throw new Error(
      `${process.platform}-${process.arch} is not a gated target; the launcher consumer runs only on the three supported hosts.`,
    );
  }
  const platformPkg = packageManifest.packages.find((p) => p.key === hostKey);
  if (platformPkg === undefined) {
    throw new Error(`No packaged platform target for this host (${hostKey}).`);
  }

  const launcherTarball = join(dir, launcherManifest.tarball);
  const platformTarball = join(dir, platformPkg.tarball);
  for (const tarball of [launcherTarball, platformTarball]) {
    if (!existsSync(tarball)) {
      throw new Error(`Tarball not found: ${tarball}.`);
    }
  }

  const root = mkdtempSync(join(tmpdir(), "secant-launcher-consumer-"));
  try {
    // Install the launcher and the matching platform package with scripts disabled.
    const consumer = join(root, "consumer");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "secant-launcher-consumer", private: true }, null, 2)}\n`,
    );
    const install = npmInstall([launcherTarball, platformTarball], consumer);
    if (install.error) throw install.error;
    if (install.status !== 0) {
      throw new Error(
        `npm install exited ${install.status}: ${install.stderr}`,
      );
    }

    const launcherDir = join(consumer, "node_modules", "@secantdev", "secant");
    const platformDir = join(consumer, "node_modules", platformPkg.package);
    if (!existsSync(launcherDir) || !existsSync(platformDir)) {
      throw new Error(
        `npm did not install both packages: launcher ${existsSync(launcherDir)}, platform ${existsSync(platformDir)}.`,
      );
    }
    const launcherEntry = join(launcherDir, LAUNCHER_FILE);

    // Forwarding under the npm-flat layout, then under a pnpm-symlinked layout.
    assertForwards(launcherEntry, version, "npm layout");
    const pnpmEntry = buildPnpmLayout(
      join(root, "pnpm"),
      launcherDir,
      platformDir,
      platformPkg.package,
    );
    assertForwards(pnpmEntry, version, "pnpm layout");

    // A missing optional package fails before spawn with an actionable diagnostic:
    // the launcher installed with no platform package beside it.
    const missingDir = join(
      root,
      "missing",
      "node_modules",
      "@secantdev",
      "secant",
    );
    mkdirSync(dirname(missingDir), { recursive: true });
    cpSync(launcherDir, missingDir, { recursive: true });
    const missing = launch(join(missingDir, LAUNCHER_FILE), ["--version"]);
    if (missing.error) throw missing.error;
    const missingText = `${missing.stdout}${missing.stderr}`;
    if (
      missing.status === 0 ||
      !missingText.includes("is not installed") ||
      !missingText.includes(platformPkg.package)
    ) {
      throw new Error(
        `The launcher did not fail before spawn on a missing optional package: status ${missing.status}, ${missingText}`,
      );
    }

    // The Proof Bundle smoke (the M3 gate) driven entirely through the launcher: on
    // this OS, build + install the Test Repair Proof Bundle, launch it against the
    // recorded Claude Code replayer to its authored Human Gate, and once answered,
    // reach `succeeded` and make the authored commit — proving the script-free npm
    // channel exercises the same candidate executable.
    const smokeRoot = join(root, "smoke");
    mkdirSync(smokeRoot, { recursive: true });
    const secantHome = join(smokeRoot, "secant-home");
    const replayerDir = join(smokeRoot, "claude-replayer");
    installReplayerAt(
      replayerDir,
      "2.1.273 (Claude Code)",
      join(
        projectRoot,
        "tests",
        "harness",
        "fixtures",
        "claude-code",
        "test-repair",
      ),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SECANT_HOME: secantHome,
      PATH: `${replayerDir}${delimiter}${runtimeDir}${delimiter}${process.env.PATH ?? ""}`,
    };
    delete env.SECANT_CLAUDE_CODE;
    delete env.SECANT_CODEX;

    const run = (
      args: readonly string[],
      opts: { cwd: string; expect?: number },
    ): string => {
      const expect = opts.expect ?? 0;
      const result = launch(launcherEntry, args, { cwd: opts.cwd, env });
      if (result.error) throw result.error;
      if (result.status !== expect) {
        throw new Error(
          `secant ${args.join(" ")} exited ${result.status} (expected ${expect}):\n${result.stdout}\n${result.stderr}`,
        );
      }
      return result.stdout;
    };

    const bundleFolder = join(projectRoot, "bundles", "test-repair-workflow");
    const proofWfb = join(smokeRoot, "proof.wfb");
    const buildOutput = run(
      ["bundle", "build", bundleFolder, "--no-install", "--output", proofWfb],
      { cwd: smokeRoot },
    );
    if (!/Digest: sha256:[0-9a-f]{64}/.test(buildOutput)) {
      throw new Error(
        `launcher bundle build did not print the digest: ${buildOutput}`,
      );
    }
    run(["bundle", "install", proofWfb], { cwd: smokeRoot });
    const listed = JSON.parse(
      run(["bundle", "list", "--json"], { cwd: smokeRoot }),
    ).result.bundles.find(
      (bundle: { id: string }) => bundle.id === "dev.secant.test-repair",
    );
    if (listed === undefined) {
      throw new Error("The launcher did not install the Proof Bundle.");
    }

    const workspaceRaw = join(smokeRoot, "workspace");
    mkdirSync(workspaceRaw, { recursive: true });
    const workspace = realpathSync.native(workspaceRaw);
    const { failingTest, baselineCommit } = seedTestRepairWorkspace(workspace);
    run(["workspace", "approve"], { cwd: workspace });

    const launched = JSON.parse(
      run(
        [
          "run",
          "launch",
          "dev.secant.test-repair",
          "--input",
          `failing-test=${failingTest}`,
          "--trust",
          listed.digest,
          "--harness",
          "claude-code",
          "--harness-requests",
          "allow",
          "--json",
        ],
        { cwd: workspace, expect: 2 },
      ),
    );
    const proofRun = launched.result?.run;
    if (
      launched.family !== "run" ||
      proofRun?.state !== "blocked" ||
      proofRun.pendingGate?.gate?.stepId !== "approve-commit"
    ) {
      throw new Error(
        `The launcher did not reach the Proof Bundle gate: ${JSON.stringify(launched)}`,
      );
    }
    if (git(["rev-parse", "HEAD"], workspace) !== baselineCommit) {
      throw new Error(
        "The Proof Bundle committed before its gate was approved through the launcher.",
      );
    }

    const answered = JSON.parse(
      run(["run", "answer", launched.runId, "--continue", "--json"], {
        cwd: workspace,
      }),
    );
    if (answered.result?.run?.state !== "succeeded") {
      throw new Error(
        `The launcher did not drive the Proof Bundle to succeeded: ${JSON.stringify(answered)}`,
      );
    }
    if (
      git(["log", "-1", "--format=%s"], workspace) !== "Repair failing test"
    ) {
      throw new Error(
        "The approved Proof Bundle did not make its authored commit through the launcher.",
      );
    }

    process.stdout.write(
      `npm-launcher-consumer passed for ${hostKey} (@secantdev/secant@${version}).\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const packagesDir = process.argv[2] ?? join(projectRoot, "dist", "packages");
  verifyLauncherConsumer(packagesDir);
}
