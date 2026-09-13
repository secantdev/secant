import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error JS helper, no types
import { TARGETS, hostTargetKey } from "./targets.mjs";

// Smokes the Bun compiled single-file executable (ADR 0030). It replaces the
// npm-tarball smoke and keeps its install-then-run shape: copy the standalone
// binary into an isolated temporary location (proving it is self-contained),
// then run every non-interactive path against that copy. CI passes the
// cross-compiled artefact for this OS as argv[2]; with no argument it smokes the
// host binary that `bun run build` wrote to dist/. #52, #53, #54 extend it.

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
    `Compiled binary not found at ${source}. Run \`bun run build\` first, or pass a binary path.`,
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

  // An unknown command and an unknown flag exit non-zero with a usage message,
  // before any composition wiring (issue #72). `run` throws on a non-zero exit,
  // so use spawnSync directly to assert the failure.
  for (const args of [["frobnicate"], ["bundle", "list", "--bogus"]]) {
    const result = spawnSync(binary, args, {
      cwd: smokeRoot,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status === 0) {
      throw new Error(`\`secant ${args.join(" ")}\` should exit non-zero.`);
    }
    const output = `${result.stdout}${result.stderr}`;
    if (!/unknown-(command|option)/.test(output)) {
      throw new Error(
        `\`secant ${args.join(" ")}\` did not print a usage message: ${output}`,
      );
    }
  }

  // Approve a temporary Workspace under a temporary SECANT_HOME, then read it
  // back with --json — the SQLite write→read round-trip (issue #50, AC7).
  const secantHome = join(smokeRoot, "secant-home");
  const workspaceDirectory = join(smokeRoot, "workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  // The runtime's directory is on PATH so a launched Command Step can spawn it by
  // bare name (the #88 materialization scenario below runs `-e` scripts).
  const runtimeDir = dirname(process.execPath);
  const workspaceEnv = {
    ...process.env,
    SECANT_HOME: secantHome,
    PATH: `${runtimeDir}${delimiter}${process.env.PATH ?? ""}`,
  };

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
  // AC8; issue #52, AC5). `run` throws on a non-zero exit, and `bundle build`
  // now gates on the Composition check — refusing with a non-zero exit and no
  // output file on any error-severity finding — so a printed digest and a
  // written file from the installed binary is the standing assertion, on each of
  // the three operating systems, that the Proof Bundle reports zero error findings.
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

  // Install the built Proof Bundle into the temporary SECANT_HOME, re-install it
  // (equal digest → already installed), then install a byte-different archive of
  // the same identity (→ identity collision) — the full first-install-wins path
  // from the installed binary on each OS (issue #53, AC7).
  const firstInstall = run(binary, ["bundle", "install", outputWfb], {
    cwd: smokeRoot,
    env: workspaceEnv,
  });
  if (!/^Installed\.$/m.test(firstInstall)) {
    throw new Error(
      `Compiled binary did not install the Proof Bundle: ${firstInstall}`,
    );
  }

  const secondInstall = run(binary, ["bundle", "install", outputWfb], {
    cwd: smokeRoot,
    env: workspaceEnv,
  });
  if (!/Already installed/.test(secondInstall)) {
    throw new Error(
      `Re-installing the equal digest was not reported as already installed: ${secondInstall}`,
    );
  }

  const afterInstall = JSON.parse(
    run(binary, ["workspace", "--json"], {
      cwd: workspaceDirectory,
      env: workspaceEnv,
    }),
  );
  if (afterInstall.installedBundleCount !== 1) {
    throw new Error(
      `Home reported ${afterInstall.installedBundleCount} Installed Bundles instead of 1.`,
    );
  }

  // List and inspect the installed Proof Bundle over the `bundle-catalog`
  // Projection with --json (issue #54, AC6): the same read-back on all three
  // operating systems, asserting identity, digest, all three platforms, and
  // zero error findings.
  const platforms = ["windows", "macos", "linux"];
  const listSnapshot = JSON.parse(
    run(binary, ["bundle", "list", "--json"], {
      cwd: smokeRoot,
      env: workspaceEnv,
    }),
  );
  const listed = (listSnapshot.result?.bundles ?? []).find(
    (bundle) => bundle.id === "dev.secant.test-repair",
  );
  if (
    !listed ||
    !/^[0-9a-f]{64}$/.test(listed.digest ?? "") ||
    platforms.some((platform) => !(listed.platforms ?? []).includes(platform))
  ) {
    throw new Error(
      `bundle list --json did not carry the installed Proof Bundle with its digest and all three platforms: ${JSON.stringify(listSnapshot)}`,
    );
  }

  const focus = JSON.parse(
    run(binary, ["bundle", "inspect", "dev.secant.test-repair", "--json"], {
      cwd: smokeRoot,
      env: workspaceEnv,
    }),
  );
  const errorFindings = (focus.compositionFindings ?? []).filter(
    (finding) => finding.severity === "error",
  );
  if (
    focus.id !== "dev.secant.test-repair" ||
    !/^[0-9a-f]{64}$/.test(focus.digest ?? "") ||
    platforms.some((platform) => !(focus.platforms ?? []).includes(platform)) ||
    errorFindings.length !== 0
  ) {
    throw new Error(
      `bundle inspect --json did not read back identity, digest, all three platforms, and zero error findings: ${JSON.stringify(focus)}`,
    );
  }

  // A byte-different archive of the same identity: rebuild a copy whose declared
  // script asset differs, so the digest changes while id and version do not.
  const variantFolder = join(smokeRoot, "variant-bundle");
  await cp(proofBundleFolder, variantFolder, { recursive: true });
  appendFileSync(
    join(variantFolder, "scripts", "run-test.sh"),
    "\n# package-smoke variant\n",
  );
  const variantWfb = join(smokeRoot, "variant.wfb");
  run(
    binary,
    ["bundle", "build", variantFolder, "--no-install", "--output", variantWfb],
    { cwd: smokeRoot, env: workspaceEnv },
  );
  const collision = spawnSync(binary, ["bundle", "install", variantWfb], {
    cwd: smokeRoot,
    encoding: "utf8",
    env: workspaceEnv,
  });
  if (collision.error) throw collision.error;
  if (
    collision.status === 0 ||
    !collision.stderr.includes("bundle-identity-collision")
  ) {
    throw new Error(
      `A byte-different same-identity archive was not rejected as an identity collision: ${collision.stdout}\n${collision.stderr}`,
    );
  }

  // Run error paths from the compiled binary (issue #82, AC7): `run show` on an
  // unknown Run id and `run launch` on an uninstalled Bundle each exit non-zero
  // with the precise Problem, before any Run directory exists.
  for (const [args, code] of [
    [["run", "show", "no-such-run"], "run-not-found"],
    [["run", "launch", "io.example.absent"], "bundle-not-installed"],
  ]) {
    const result = spawnSync(binary, args, {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: workspaceEnv,
    });
    if (result.error) throw result.error;
    if (result.status === 0) {
      throw new Error(`\`secant ${args.join(" ")}\` should exit non-zero.`);
    }
    const output = `${result.stdout}${result.stderr}`;
    if (!output.includes(code)) {
      throw new Error(
        `\`secant ${args.join(" ")}\` did not print ${code}: ${output}`,
      );
    }
  }

  // Preflight refusals from the compiled binary (issue #83, AC7), each before any
  // Run exists. The Proof Bundle carries an Agent step, so launching it is refused
  // with the intrinsic Step-kind Problem; a Command-only Bundle that requires a
  // Git worktree root is refused with the git-worktree-root Problem when launched
  // from the non-repository workspace. Neither needs a trust acknowledgement:
  // Preflight runs ahead of the Trust gate.
  const gitGuardFolder = join(projectRoot, "bundles", "git-guard-command");
  const gitGuardWfb = join(smokeRoot, "git-guard.wfb");
  run(
    binary,
    [
      "bundle",
      "build",
      gitGuardFolder,
      "--no-install",
      "--output",
      gitGuardWfb,
    ],
    { cwd: smokeRoot, env: workspaceEnv },
  );
  run(binary, ["bundle", "install", gitGuardWfb], {
    cwd: smokeRoot,
    env: workspaceEnv,
  });

  for (const [args, needle] of [
    [["run", "launch", "dev.secant.test-repair"], "step-kind-not-executable"],
    [["run", "launch", "dev.secant.git-guard"], "git-worktree-root"],
  ]) {
    const result = spawnSync(binary, args, {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: workspaceEnv,
    });
    if (result.error) throw result.error;
    if (result.status === 0) {
      throw new Error(`\`secant ${args.join(" ")}\` should exit non-zero.`);
    }
    const output = `${result.stdout}${result.stderr}`;
    if (!output.includes(needle)) {
      throw new Error(
        `\`secant ${args.join(" ")}\` did not report a Preflight refusal (${needle}): ${output}`,
      );
    }
  }

  // Workspace materialization, verification, conflict, and resume from the
  // compiled binary on each gated OS (issue #88, AC6). A `home: workspace` text
  // Artifact is materialized to its declared path; a middle Step modifies that
  // copy; the next Step's byte-for-byte verify rests the Run `halted` with a
  // conflict `run show` names; restoring the file and `run resume` continues it.
  {
    const runtime = basename(process.execPath);
    const relPath = "out/materialized.txt";
    const absPath = join(canonicalWorkspace, "out", "materialized.txt");
    const content = "materialized-by-secant";
    const tamperScript = `require('node:fs').writeFileSync(${JSON.stringify(absPath)}, 'CHANGED')`;
    const id = "dev.secant.materialize-smoke";
    const manifest = {
      formatVersion: 1,
      bundle: {
        id,
        version: "1.0.0",
        name: "Materialize Smoke",
        description: "Workspace materialization smoke Bundle.",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [],
      routing: [
        {
          id: "produce",
          kind: "command",
          produces: [
            { name: "x", type: "text", home: "workspace", path: relPath },
          ],
          command: {
            executable: runtime,
            arguments: [
              "-e",
              `process.stdout.write(${JSON.stringify(content)})`,
            ],
          },
        },
        {
          id: "tamper",
          kind: "command",
          produces: [{ name: "tamperlog", type: "text" }],
          command: { executable: runtime, arguments: ["-e", tamperScript] },
        },
        {
          id: "consume",
          kind: "command",
          requires: ["x"],
          produces: [{ name: "y", type: "text" }],
          command: {
            executable: runtime,
            arguments: [
              "-e",
              "process.stdout.write('done')",
              { artifact: "x" },
            ],
          },
        },
      ],
    };
    const folder = join(smokeRoot, "materialize-bundle");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    run(binary, ["bundle", "build", folder], {
      cwd: smokeRoot,
      env: workspaceEnv,
    });

    const listJson = run(binary, ["bundle", "list", "--json"], {
      cwd: workspaceDirectory,
      env: workspaceEnv,
    });
    const installed = JSON.parse(listJson).result.bundles.find(
      (bundle) => bundle.id === id,
    );
    if (installed === undefined) {
      throw new Error(`Materialization Bundle was not installed: ${listJson}`);
    }

    const launched = spawnSync(
      binary,
      ["run", "launch", id, "--trust", installed.digest, "--json"],
      { cwd: workspaceDirectory, encoding: "utf8", env: workspaceEnv },
    );
    if (launched.error) throw launched.error;
    if (launched.status === 0) {
      throw new Error(
        "A launch that halts on a conflict should exit non-zero.",
      );
    }
    const launchSnapshot = JSON.parse(launched.stdout);
    const runId = launchSnapshot.runId;
    if (launchSnapshot.result.run.state !== "halted") {
      throw new Error(
        `Expected the Run to rest halted on the conflict: ${launched.stdout}`,
      );
    }
    // The materialized copy is left exactly as the tamper left it — never
    // overwritten and never adopted as the new version.
    if (readFileSync(absPath, "utf8") !== "CHANGED") {
      throw new Error("The Workspace copy was overwritten on the conflict.");
    }

    const shown = run(binary, ["run", "show", runId], {
      cwd: workspaceDirectory,
      env: workspaceEnv,
    });
    if (
      !shown.includes("Materialization conflict") ||
      !shown.includes(relPath)
    ) {
      throw new Error(
        `\`run show\` did not name the conflict and its path: ${shown}`,
      );
    }

    // Restore the file to its bound content, then resume: the Run continues.
    await writeFile(absPath, content);
    const resumed = spawnSync(binary, ["run", "resume", runId], {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: workspaceEnv,
    });
    if (resumed.error) throw resumed.error;
    if (
      resumed.status !== 0 ||
      !`${resumed.stdout}`.includes("State: succeeded")
    ) {
      throw new Error(
        `Resuming after restoring the file did not continue the Run: ${resumed.stdout}${resumed.stderr}`,
      );
    }
  }

  // Answer a durable Human Gate across process invocations from the compiled
  // binary on each gated OS (issue #85, AC6). A Repeat group blocks at its Review
  // checkpoint under one invocation; a second, separate invocation answers the
  // Gate `--continue`, granting one more interval that reaches the pass and rests
  // the Run `succeeded` — the answer survived process death as a durable Artifact.
  {
    const runtime = basename(process.execPath);
    const id = "dev.secant.answer-smoke";
    const counterPath = join(smokeRoot, "answer-counter");
    // The `check` Command counts iterations through a shared file and passes on
    // its 3rd run, so the granted interval (iterations 3+) reaches the pass.
    const checkScript =
      `const fs=require('node:fs');const p=${JSON.stringify(counterPath)};` +
      `let n=0;try{n=Number(fs.readFileSync(p,'utf8'))||0;}catch{}` +
      `n++;fs.writeFileSync(p,String(n));process.exit(n>=3?0:1);`;
    const manifest = {
      formatVersion: 1,
      bundle: {
        id,
        version: "1.0.0",
        name: "Answer Smoke",
        description: "Human Gate answer smoke Bundle.",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [],
      routing: [
        {
          id: "baseline",
          kind: "command",
          produces: [{ name: "passing", type: "verdict" }],
          command: {
            executable: runtime,
            arguments: ["-e", "process.exit(1)"],
          },
        },
        {
          repeat: {
            until: "passing",
            reviewCheckpoint: { interval: 2, message: "please review" },
            steps: [
              {
                id: "check",
                kind: "command",
                produces: [{ name: "passing", type: "verdict" }],
                command: {
                  executable: runtime,
                  arguments: ["-e", checkScript],
                },
              },
            ],
          },
        },
      ],
    };
    const folder = join(smokeRoot, "answer-bundle");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    run(binary, ["bundle", "build", folder], {
      cwd: smokeRoot,
      env: workspaceEnv,
    });

    const listJson = run(binary, ["bundle", "list", "--json"], {
      cwd: workspaceDirectory,
      env: workspaceEnv,
    });
    const installed = JSON.parse(listJson).result.bundles.find(
      (bundle) => bundle.id === id,
    );
    if (installed === undefined) {
      throw new Error(`Answer Bundle was not installed: ${listJson}`);
    }

    // First invocation: launch, which blocks at the checkpoint.
    const launched = spawnSync(
      binary,
      ["run", "launch", id, "--trust", installed.digest, "--json"],
      { cwd: workspaceDirectory, encoding: "utf8", env: workspaceEnv },
    );
    if (launched.error) throw launched.error;
    const launchSnapshot = JSON.parse(launched.stdout);
    const runId = launchSnapshot.runId;
    if (launchSnapshot.result.run.state !== "blocked") {
      throw new Error(
        `Expected the Run to rest blocked at the checkpoint: ${launched.stdout}`,
      );
    }

    // Second, separate invocation: answer the durable Gate `--continue`.
    const answered = spawnSync(binary, ["run", "answer", runId, "--continue"], {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: workspaceEnv,
    });
    if (answered.error) throw answered.error;
    if (
      answered.status !== 0 ||
      !`${answered.stdout}`.includes("State: succeeded")
    ) {
      throw new Error(
        `Answering --continue in a fresh invocation did not resolve the Run: ${answered.stdout}${answered.stderr}`,
      );
    }
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
