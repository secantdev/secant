import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error JS helper, no types
import { TARGETS, hostTargetKey } from "./targets.mjs";

// Smokes the Bun compiled single-file executable (ADR 0030). It replaces the
// npm-tarball smoke and keeps its install-then-run shape: copy the standalone
// binary into an isolated temporary location (proving it is self-contained),
// then run every non-interactive path against that copy. CI passes the
// cross-compiled artefact for this OS as argv[2]; with no argument it smokes the
// host binary that `npm run build` wrote to dist/. #52, #53, #54 extend it.

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));

function hostBinary() {
  const key = hostTargetKey(process.platform, process.arch);
  if (key === undefined) {
    throw new Error(
      `No gated target for ${process.platform}-${process.arch}; pass a binary path.`,
    );
  }
  return join(projectRoot, "dist", TARGETS[key].outfile);
}

const source = process.argv[2] ? resolve(process.argv[2]) : hostBinary();
if (!existsSync(source)) {
  throw new Error(
    `Compiled binary not found at ${source}. Run \`npm run build\` first, or pass a binary path.`,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
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

const smokeRoot = await mkdtemp(join(tmpdir(), "secant-binary-smoke-"));

try {
  // "Install" the binary into the isolated location and run it from there, so a
  // stray sibling in dist/ or the working directory cannot mask a non-self-
  // contained binary.
  const binary = join(smokeRoot, basename(source));
  await copyFile(source, binary);
  if (process.platform !== "win32") await chmod(binary, 0o755);

  // Apple silicon refuses arm64 code without at least Bun's ad-hoc signature,
  // which has regressed twice (ADR 0030); verify it before running the binary.
  if (process.platform === "darwin") {
    run("codesign", ["--verify", "--deep", "--strict", binary]);
  }

  const helpOutput = run(binary, ["--help"], { cwd: smokeRoot });
  if (!helpOutput.includes("Usage: secant")) {
    throw new Error("Compiled binary help output did not identify secant.");
  }

  const versionOutput = run(binary, ["--version"], { cwd: smokeRoot });
  // The embedded version must print exactly, and nothing else.
  if (versionOutput !== `${pkg.version}\n`) {
    throw new Error(
      `Compiled binary reported version ${JSON.stringify(versionOutput)} instead of ${JSON.stringify(`${pkg.version}\n`)}.`,
    );
  }

  // Approve a temporary Workspace under a temporary SECANT_HOME, then read it
  // back with --json — the SQLite write→read round-trip (issue #50, AC7).
  const secantHome = join(smokeRoot, "secant-home");
  const workspaceDirectory = join(smokeRoot, "workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const workspaceEnv = { ...process.env, SECANT_HOME: secantHome };

  run(binary, ["workspace", "approve"], {
    cwd: workspaceDirectory,
    env: workspaceEnv,
  });

  const workspaceJson = run(binary, ["workspace", "--json"], {
    cwd: workspaceDirectory,
    env: workspaceEnv,
  });
  const snapshot = JSON.parse(workspaceJson);
  // Match the CLI's own canonicalization (realpathSync.native), so a Windows
  // 8.3 short name in the temp path does not read as a different directory.
  const canonicalWorkspace = realpathSync.native(workspaceDirectory);
  if (snapshot.approval?.state !== "approved") {
    throw new Error(
      `Compiled binary did not report the approved Workspace: ${workspaceJson}`,
    );
  }
  if (snapshot.path !== canonicalWorkspace) {
    throw new Error(
      `Compiled binary reported Workspace path ${snapshot.path} instead of ${canonicalWorkspace}.`,
    );
  }

  // Build the Proof Bundle with --no-install --output on this OS (issue #51,
  // AC8): assert the digest is printed and the file is written.
  const proofBundleFolder = join(
    projectRoot,
    "bundles",
    "test-repair-workflow",
  );
  const outputWfb = join(smokeRoot, "proof.wfb");
  const buildOutput = run(
    binary,
    [
      "bundle",
      "build",
      proofBundleFolder,
      "--no-install",
      "--output",
      outputWfb,
    ],
    { cwd: smokeRoot, env: workspaceEnv },
  );
  if (!/Digest: sha256:[0-9a-f]{64}/.test(buildOutput)) {
    throw new Error(
      `Compiled binary did not print the Proof Bundle digest: ${buildOutput}`,
    );
  }
  if (!existsSync(outputWfb)) {
    throw new Error(
      "Compiled binary did not write the Proof Bundle output file.",
    );
  }

  // Launch the shell with no interactive terminal (issue #55, AC9): stdio is
  // piped, so stdin/stdout are not TTYs and the launch rejects with the precise
  // startup Problem and a non-zero exit before the renderer is created.
  const shellResult = spawnSync(binary, [], {
    cwd: smokeRoot,
    encoding: "utf8",
    env: workspaceEnv,
  });
  if (shellResult.error) throw shellResult.error;
  if (shellResult.status === 0) {
    throw new Error(
      "Compiled shell should reject a non-interactive launch with a non-zero exit.",
    );
  }
  if (!shellResult.stderr.includes("no-interactive-terminal")) {
    throw new Error(
      `Compiled shell did not print the startup Problem: ${shellResult.stdout}\n${shellResult.stderr}`,
    );
  }

  process.stdout.write(
    `Compiled binary smoke passed for ${source} (@secantdev/secant@${pkg.version}).\n`,
  );
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
