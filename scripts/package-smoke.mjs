import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Per the runtime decision (#21), resolve the Windows npm shim to npm's real
// JavaScript entry and run it under this Node directly, never through a shell.
// npm sets npm_execpath to npm-cli.js for every `npm run` script, which is how
// this smoke is always invoked.
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath || !/\.[cm]?js$/i.test(npmCliPath)) {
  throw new Error(
    "package smoke must run under an npm script so npm_execpath resolves to npm's JavaScript entry.",
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited with status ${result.status}.`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

function npm(args, options = {}) {
  return run(process.execPath, [npmCliPath, ...args], options);
}

const smokeRoot = await mkdtemp(join(tmpdir(), "secant-package-smoke-"));

try {
  npm(["pack", "--pack-destination", smokeRoot]);

  const archiveName = (await readdir(smokeRoot)).find((entry) =>
    entry.endsWith(".tgz"),
  );

  if (archiveName === undefined) {
    throw new Error("npm pack did not produce a package archive.");
  }

  await writeFile(
    join(smokeRoot, "package.json"),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );

  npm(
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(smokeRoot, archiveName),
    ],
    { cwd: smokeRoot },
  );

  const packageDirectory = join(
    smokeRoot,
    "node_modules",
    "@secantdev",
    "secant",
  );
  const packageJson = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  const entrypoint = packageJson.bin?.secant;

  if (typeof entrypoint !== "string") {
    throw new Error("The installed package does not declare the secant bin.");
  }

  const installedEntrypoint = resolve(packageDirectory, entrypoint);
  const helpOutput = run(process.execPath, [installedEntrypoint, "--help"], {
    cwd: smokeRoot,
  });
  const versionOutput = run(
    process.execPath,
    [installedEntrypoint, "--version"],
    { cwd: smokeRoot },
  );

  if (!helpOutput.includes("Usage: secant")) {
    throw new Error("Installed package help output did not identify secant.");
  }

  if (versionOutput.trim() !== packageJson.version) {
    throw new Error(
      `Installed package reported version ${versionOutput.trim()} instead of ${packageJson.version}.`,
    );
  }

  // Approve a temporary Workspace under a temporary SECANT_HOME from the
  // installed package, then read it back with --json (issue #50, AC7).
  const secantHome = join(smokeRoot, "secant-home");
  const workspaceDirectory = join(smokeRoot, "workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const workspaceEnv = { ...process.env, SECANT_HOME: secantHome };

  run(process.execPath, [installedEntrypoint, "workspace", "approve"], {
    cwd: workspaceDirectory,
    env: workspaceEnv,
  });

  const workspaceJson = run(
    process.execPath,
    [installedEntrypoint, "workspace", "--json"],
    { cwd: workspaceDirectory, env: workspaceEnv },
  );
  const snapshot = JSON.parse(workspaceJson);
  // Match the CLI's own canonicalization (realpathSync.native), so a Windows
  // 8.3 short name in the temp path does not read as a different directory.
  const canonicalWorkspace = realpathSync.native(workspaceDirectory);
  if (snapshot.approval?.state !== "approved") {
    throw new Error(
      `Installed package did not report the approved Workspace: ${workspaceJson}`,
    );
  }
  if (snapshot.path !== canonicalWorkspace) {
    throw new Error(
      `Installed package reported Workspace path ${snapshot.path} instead of ${canonicalWorkspace}.`,
    );
  }

  process.stdout.write(
    `Installed package smoke passed for @secantdev/secant@${packageJson.version}.\n`,
  );
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
