import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
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
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import which from "which";
import { TARGETS, hostTargetKey } from "./targets.js";
import { installReplayerAt } from "../tests/harness/replayer-install.js";
import { installCodexReplayerAt } from "../tests/harness/codex-replayer-install.js";
import { seedTestRepairWorkspace } from "../tests/helpers/testRepairWorkspace.js";
import { runNamedScenario } from "./package-smoke/scenario.js";

// Smokes the Bun compiled single-file executable (ADR 0030). It replaces the
// npm-tarball smoke and keeps its install-then-run shape: copy the standalone
// binary into an isolated temporary location (proving it is self-contained),
// then run every non-interactive path against that copy. CI passes the
// cross-compiled artefact for this OS as argv[2]; with no argument it smokes the
// host binary that `bun run build` wrote to dist/. #52, #53, #54 extend it.

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));

// The runtime's directory goes on every isolated env's PATH so a launched Command
// Step can spawn it by bare name (the #88 materialization scenario runs `-e`
// scripts). Module scope so `homeEnv` closes over it.
const runtimeDir = dirname(process.execPath);

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

type RunOptions = SpawnSyncOptions & { expect?: number };

// `expect` is the required exit code (default 0). A Run resting blocked at its
// checkpoint exits 2 (A36) — a known, deliberate code — so the gate scenarios
// assert it through this helper instead of dropping to raw spawnSync. Returns
// stdout; sites that need a non-zero exit or the full result keep raw spawnSync.
function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): string {
  const { expect = 0, ...spawnOptions } = options;
  const result = spawnSync(command, [...args], {
    cwd: projectRoot,
    ...spawnOptions,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== expect) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited with status ${result.status} (expected ${expect}).`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}

/** The base env for an isolated SECANT_HOME with the runtime dir on PATH (A35):
 *  the workspace, legacy, and SIGINT scenarios differ only by SECANT_HOME. */
function homeEnv(secantHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SECANT_HOME: secantHome,
    PATH: `${runtimeDir}${delimiter}${process.env.PATH ?? ""}`,
  };
}

/** Write a manifest, build (default-install) the Bundle, and confirm it installed,
 *  returning its catalog row (A35): the win32 branch and three scenarios shared
 *  this exact shape. Distinct from the `--no-install --output` + `bundle install`
 *  family, which stays inline. */
async function buildAndInstall(
  binary: string,
  folder: string,
  manifest: { bundle: { id: string } },
  where: {
    build: string;
    list: string;
    env: NodeJS.ProcessEnv;
    label: string;
  },
): Promise<{ id: string; digest: string }> {
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  run(binary, ["bundle", "build", folder], {
    cwd: where.build,
    env: where.env,
  });
  const installed = JSON.parse(
    run(binary, ["bundle", "list", "--json"], {
      cwd: where.list,
      env: where.env,
    }),
  ).result.bundles.find(
    (bundle: { id: string }) => bundle.id === manifest.bundle.id,
  );
  if (installed === undefined) {
    throw new Error(`${where.label} Bundle was not installed.`);
  }
  return installed;
}

/** Assert each command exits non-zero and its combined stdout+stderr matches the
 *  expected code/needle (A35): the unknown-command, not-found, and Preflight
 *  refusal loops were three copies of this. A string `match` is a substring; a
 *  RegExp is tested. */
function assertRefuses(
  binary: string,
  cases: readonly {
    args: readonly string[];
    match: string | RegExp;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    detail: string;
  }[],
): void {
  for (const scenario of cases) {
    const result = spawnSync(binary, [...scenario.args], {
      cwd: scenario.cwd,
      encoding: "utf8",
      ...(scenario.env !== undefined ? { env: scenario.env } : {}),
    });
    if (result.error) throw result.error;
    if (result.status === 0) {
      throw new Error(
        `\`secant ${scenario.args.join(" ")}\` should exit non-zero.`,
      );
    }
    const output = `${result.stdout}${result.stderr}`;
    const matched =
      typeof scenario.match === "string"
        ? output.includes(scenario.match)
        : scenario.match.test(output);
    if (!matched) {
      throw new Error(
        `\`secant ${scenario.args.join(" ")}\` ${scenario.detail}: ${output}`,
      );
    }
  }
}

function assertMigrated(
  databasePath: string,
  label: string,
  expected = 1,
): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .query("SELECT COUNT(*) AS count FROM __drizzle_migrations")
      .get() as { count: number } | null;
    if (row?.count !== expected) {
      throw new Error(
        `Compiled binary did not record the embedded ${label} migrations ` +
          `(expected ${expected}, found ${row?.count ?? 0}).`,
      );
    }
  } finally {
    database.close();
  }
}

function findWindowsAppExecutionAlias():
  { readonly name: string; readonly args: readonly string[] } | undefined {
  if (process.platform !== "win32") return undefined;
  for (const candidate of [
    { name: "pwsh", args: ["--version"] },
    { name: "winget", args: ["--version"] },
  ] as const) {
    const pathMatch = which.sync(candidate.name, { nothrow: true });
    if (typeof pathMatch === "string") continue;
    const fallback = spawnSync("where.exe", [candidate.name], {
      encoding: "utf8",
      windowsHide: true,
    });
    const firstMatch = fallback.stdout?.split(/\r?\n/, 1)[0]?.trim();
    if (fallback.status === 0 && firstMatch) return candidate;
  }
  return undefined;
}

/** A pre-M4 Run has no semantic Harness selection until the legacy-upgrade slice
 *  assigns one. The migration must preserve that absence rather than inventing
 *  `claude-code` from the Adapter that happened to exist at the time. */
function assertLegacyRunRemainsUnselected(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .query("SELECT selected_harness AS selectedHarness FROM run_record")
      .get() as { selectedHarness: string | null } | null;
    if (row === null) {
      throw new Error("Compiled binary migration lost the pre-M4 Run record.");
    }
    if (row.selectedHarness !== null) {
      throw new Error(
        "Compiled binary migration invented a selected Harness for a pre-M4 Run.",
      );
    }
  } finally {
    database.close();
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Poll for a file to appear, up to a deadline. */
async function waitForFile(path: string, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (existsSync(path)) return true;
    await sleep(50);
  }
  return false;
}

const smokeRoot = await mkdtemp(join(tmpdir(), "secant-binary-smoke-"));

try {
  async function compiledBinaryInterfaceScenario(): Promise<string> {
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
    // before any composition wiring (issue #72).
    assertRefuses(binary, [
      {
        args: ["frobnicate"],
        match: /unknown-(command|option)/,
        cwd: smokeRoot,
        detail: "did not print a usage message",
      },
      {
        args: ["bundle", "list", "--bogus"],
        match: /unknown-(command|option)/,
        cwd: smokeRoot,
        detail: "did not print a usage message",
      },
    ]);

    return binary;
  }

  const binary = await runNamedScenario(
    "compiled-binary-interface",
    compiledBinaryInterfaceScenario,
  );

  // Approve a temporary Workspace under a temporary SECANT_HOME, then read it
  // back with --json — the SQLite write→read round-trip (issue #50, AC7).
  const secantHome = join(smokeRoot, "secant-home");
  const workspaceDirectory = join(smokeRoot, "workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const workspaceEnv = homeEnv(secantHome);

  // A compiled binary carries all three migration registries with it. Relocate the
  // checked-in pre-Drizzle home beneath this isolated install, retarget its one Run
  // to a different working directory, then open it from there. This exercises the
  // catalog, coordination, and run.db migrations without relying on the source tree
  // or the process's original cwd, on every gated operating system (#101).
  async function relocatedPreDrizzleHomeScenario(): Promise<void> {
    const legacyHome = join(smokeRoot, "pre-drizzle-home");
    await cp(
      join(projectRoot, "tests", "fixtures", "pre-drizzle-home"),
      legacyHome,
      {
        recursive: true,
      },
    );
    const legacyWorkspace = join(smokeRoot, "pre-drizzle-workspace");
    await mkdir(legacyWorkspace, { recursive: true });
    const canonicalLegacyWorkspace = realpathSync.native(legacyWorkspace);
    const runsRoot = join(legacyHome, "runs");
    const [fixtureGroup] = await readdir(runsRoot);
    if (fixtureGroup === undefined) {
      throw new Error("The pre-Drizzle fixture has no Run group.");
    }
    const slug = basename(canonicalLegacyWorkspace)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    const digest = createHash("sha256")
      .update(canonicalLegacyWorkspace)
      .digest("hex")
      .slice(0, 16);
    const relocatedGroup = `${slug || "workspace"}--${digest}`;
    await rename(join(runsRoot, fixtureGroup), join(runsRoot, relocatedGroup));
    const groupDir = join(runsRoot, relocatedGroup);
    const [runId] = (await readdir(groupDir)).filter(
      (entry) => entry !== "coordination.db",
    );
    if (runId === undefined) {
      throw new Error("The pre-Drizzle fixture has no Run Store.");
    }
    const runDatabase = new Database(join(groupDir, runId, "run.db"));
    runDatabase
      .query("UPDATE run_record SET workspace_path = ?")
      .run(canonicalLegacyWorkspace);
    runDatabase.close();

    const legacyEnv = homeEnv(legacyHome);
    const listed = JSON.parse(
      run(binary, ["run", "list", "--json"], {
        cwd: legacyWorkspace,
        env: legacyEnv,
      }),
    );
    if (!Array.isArray(listed.rows) || listed.rows[0]?.runId !== runId) {
      throw new Error(
        `Compiled binary did not migrate and open the pre-Drizzle home: ${JSON.stringify(listed)}`,
      );
    }
    assertMigrated(join(legacyHome, "catalog.db"), "Catalog");
    assertMigrated(join(groupDir, "coordination.db"), "coordination", 2);
    // The Run Store carries eleven migrations: #108 added `pending_gate`, #116 added
    // the Harness Turn records (`harness_session`/`turn`/`turn_event`/
    // `transcript_entry`) and Attempt `effective_model`, #126 added the durable Turn
    // `kind` column, and #125 added the Attempt Harness-identity columns
    // (`harness`/`executable`/`executable_version`), #133 moved ownership into the
    // Run Store, #134 added the persisted steer capability evidence, #138 added
    // the Run's semantic selected-Harness id, #187 added the requested-model column,
    // #213 added gate suggestions, and #218 added the attempt-log End Stage mark.
    const runDatabasePath = join(groupDir, runId, "run.db");
    assertMigrated(runDatabasePath, "Run Store", 11);
    assertLegacyRunRemainsUnselected(runDatabasePath);
  }

  await runNamedScenario(
    "relocated-pre-drizzle-home",
    relocatedPreDrizzleHomeScenario,
  );

  async function workspaceCatalogScenario(): Promise<string> {
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

    return canonicalWorkspace;
  }

  const canonicalWorkspace = await runNamedScenario(
    "workspace-catalog",
    workspaceCatalogScenario,
  );

  async function harnessCatalogHeadlessScenario(): Promise<void> {
    const claudeDirectory = join(smokeRoot, "harness-catalog-claude");
    const codexDirectory = join(smokeRoot, "harness-catalog-codex");
    installReplayerAt(claudeDirectory, "2.1.273 (Claude Code)");
    installCodexReplayerAt(codexDirectory, "codex-qualification");
    const catalogEnv = {
      ...workspaceEnv,
      PATH: `${claudeDirectory}${delimiter}${codexDirectory}${delimiter}${workspaceEnv.PATH ?? ""}`,
    };

    const listed = JSON.parse(
      run(binary, ["harness", "list", "--json"], {
        cwd: workspaceDirectory,
        env: catalogEnv,
      }),
    );
    const ids = (listed.harnesses ?? []).map(
      (harness: { id: string }) => harness.id,
    );
    if (
      listed.family !== "harness-catalog" ||
      listed.view !== "list" ||
      ids.join(",") !== "claude-code,codex" ||
      listed.harnesses.some(
        (harness: { qualification?: { state?: string } }) =>
          harness.qualification?.state !== "not-checked",
      ) ||
      "actionOffers" in listed
    ) {
      throw new Error(
        `harness list --json did not remain spawn-free and action-free: ${JSON.stringify(listed)}`,
      );
    }

    const focused = JSON.parse(
      run(binary, ["harness", "inspect", "codex", "--json"], {
        cwd: workspaceDirectory,
        env: catalogEnv,
      }),
    );
    if (
      focused.id !== "codex" ||
      !["qualified", "qualified-with-limits"].includes(
        focused.qualification?.state,
      ) ||
      focused.supportedModels?.kind !== "list" ||
      !Array.isArray(focused.supportedModels.models) ||
      focused.capabilities?.length !== 6 ||
      typeof focused.configurationPosture !== "string" ||
      "actionOffers" in focused
    ) {
      throw new Error(
        `harness inspect --json did not carry the normalized qualified focus: ${JSON.stringify(focused)}`,
      );
    }

    assertRefuses(binary, [
      {
        args: ["harness", "inspect", "gemini"],
        match: "harness-not-found",
        cwd: workspaceDirectory,
        env: catalogEnv,
        detail: "did not refuse an unknown semantic Harness id",
      },
    ]);
  }

  await runNamedScenario(
    "harness-catalog-headless",
    harnessCatalogHeadlessScenario,
  );

  async function installAndCatalogScenario() {
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
      (bundle: { id: string }) => bundle.id === "dev.secant.test-repair",
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
      (finding: { severity: string }) => finding.severity === "error",
    );
    if (
      focus.id !== "dev.secant.test-repair" ||
      !/^[0-9a-f]{64}$/.test(focus.digest ?? "") ||
      platforms.some(
        (platform) => !(focus.platforms ?? []).includes(platform),
      ) ||
      errorFindings.length !== 0
    ) {
      throw new Error(
        `bundle inspect --json did not read back identity, digest, all three platforms, and zero error findings: ${JSON.stringify(focus)}`,
      );
    }

    return { listed, proofBundleFolder };
  }

  const { listed, proofBundleFolder } = await runNamedScenario(
    "install-and-catalog",
    installAndCatalogScenario,
  );

  async function twoHarnessProofBundleScenario(): Promise<void> {
    // The `two-harness-proof-bundle` scenario (#149, replacing the M3 single-Harness
    // #119 smoke). Run the one installed Test Repair Proof Bundle headlessly through
    // both recorded replayers — Claude Code and Codex — in two fresh Workspaces with
    // identical routing and launch-input shape, varying only the externally supplied
    // `--harness` selection. For each: the failing baseline enters one repair
    // iteration; the recording applies its Workspace patch; the next Verdict passes;
    // and the authored approve-commit gate keeps Git unchanged until a separate
    // `run answer --continue` invocation succeeds and makes the commit. Both
    // Run-driving commands use the frozen --json envelope from the compiled binary,
    // and only the temporary PATH selects each fake Harness. The two scenarios report
    // different effective models, proving the compiled binary drives both Adapters.
    // `evidence` asserts the Harness-specific observable identity that proves the
    // compiled binary really drove that Adapter's own seam — not just that a Run
    // reached the gate. This keeps the M3 permission-bridge invariant checked in the
    // compiled binary specifically, generalized across the two Adapters.
    type TimelineEvent = { event: string; detail?: string };
    const twoHarnessScenarios: readonly {
      harness: "claude-code" | "codex";
      effectiveModel: string;
      replayerDirectory: string;
      install: () => void;
      evidence: (timeline: readonly TimelineEvent[]) => boolean;
    }[] = [
      {
        harness: "claude-code",
        effectiveModel: "claude-opus-5[1m]",
        replayerDirectory: join(smokeRoot, "claude-replayer"),
        install() {
          installReplayerAt(
            this.replayerDirectory,
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
        },
        // Claude Code surfaces the Edit as an approval request the client answers by
        // policy — the permission-bridge seam the M3 #119 smoke asserted.
        evidence: (timeline) =>
          timeline.some(
            (event) =>
              event.event === "request-raised" &&
              /^Edit .*sum\.mjs/.test(event.detail ?? ""),
          ) &&
          timeline.some(
            (event) =>
              event.event === "request-answered" &&
              event.detail === "answered by client policy (allow)",
          ),
      },
      {
        harness: "codex",
        effectiveModel: "gpt-5.6-sol",
        replayerDirectory: join(smokeRoot, "codex-replayer"),
        install() {
          installCodexReplayerAt(this.replayerDirectory, "test-repair");
        },
        // Codex auto-approves the edit internally: no approval request crosses to the
        // client; the edit is observable only as a generic tool-activity event.
        evidence: (timeline) =>
          timeline.some(
            (event) =>
              event.event === "tool-activity" &&
              event.detail === "file-change completed",
          ) && !timeline.some((event) => event.event === "request-raised"),
      },
    ];
    for (const scenario of twoHarnessScenarios) {
      scenario.install();
      // Canonicalize the Workspace so the `file` launch input (an absolute
      // passthrough) names the same directory the Adapter is prepared against; the
      // Codex replayer strict-redacts the Workspace path in the rendered prompt.
      const proofWorkspaceRaw = join(
        smokeRoot,
        `two-harness-${scenario.harness}-workspace`,
      );
      await mkdir(proofWorkspaceRaw, { recursive: true });
      const proofWorkspace = realpathSync.native(proofWorkspaceRaw);
      const { failingTest, baselineCommit } =
        seedTestRepairWorkspace(proofWorkspace);
      const proofEnv: NodeJS.ProcessEnv = {
        ...workspaceEnv,
        PATH: `${scenario.replayerDirectory}${delimiter}${workspaceEnv.PATH}`,
      };
      delete proofEnv.SECANT_CLAUDE_CODE;
      delete proofEnv.SECANT_CODEX;
      run(binary, ["workspace", "approve"], {
        cwd: proofWorkspace,
        env: proofEnv,
      });

      const launchedJson = run(
        binary,
        [
          "run",
          "launch",
          "dev.secant.test-repair",
          "--input",
          `failing-test=${failingTest}`,
          "--trust",
          listed.digest,
          "--harness",
          scenario.harness,
          "--harness-requests",
          "allow",
          "--json",
        ],
        { cwd: proofWorkspace, env: proofEnv, expect: 2 },
      );
      const launched = JSON.parse(launchedJson);
      const proofRun = launched.result?.run;
      if (
        launched.family !== "run" ||
        typeof launched.runId !== "string" ||
        launched.result?.found !== true ||
        proofRun?.runId !== launched.runId ||
        proofRun.bundle?.id !== "dev.secant.test-repair" ||
        proofRun.state !== "blocked" ||
        !Array.isArray(proofRun.progress) ||
        !Array.isArray(proofRun.timeline) ||
        !Array.isArray(proofRun.outputs) ||
        !Array.isArray(proofRun.actionOffers) ||
        proofRun.pendingGate?.gate?.shape !== "approve-reject" ||
        proofRun.pendingGate?.gate?.stepId !== "approve-commit" ||
        proofRun.effectiveModel !== scenario.effectiveModel ||
        proofRun.progress.find(
          (step: { id: string; status: string }) => step.id === "fix",
        )?.status !== "succeeded" ||
        proofRun.timeline.filter(
          (event: { event: string }) => event.event === "iteration",
        ).length !== 1 ||
        !scenario.evidence(proofRun.timeline as TimelineEvent[])
      ) {
        throw new Error(
          `Installed Proof Bundle did not reach its authored gate through ${scenario.harness} with the frozen Run JSON fields: ${launchedJson}`,
        );
      }
      if (
        run("git", ["rev-parse", "HEAD"], { cwd: proofWorkspace }).trim() !==
        baselineCommit
      ) {
        throw new Error(
          `The Proof Bundle committed before its authored gate was approved through ${scenario.harness}.`,
        );
      }

      const answeredJson = run(
        binary,
        ["run", "answer", launched.runId, "--continue", "--json"],
        { cwd: proofWorkspace, env: proofEnv },
      );
      const answered = JSON.parse(answeredJson);
      if (
        answered.family !== "run" ||
        answered.runId !== launched.runId ||
        answered.result?.found !== true ||
        answered.result.run?.state !== "succeeded" ||
        answered.result.run?.pendingGate !== undefined
      ) {
        throw new Error(
          `Installed Proof Bundle did not exit 0 at succeeded through ${scenario.harness} with the frozen Run JSON fields: ${answeredJson}`,
        );
      }
      if (
        run("git", ["log", "-1", "--format=%s"], {
          cwd: proofWorkspace,
        }).trim() !== "Repair failing test"
      ) {
        throw new Error(
          `The approved Proof Bundle did not make its authored commit through ${scenario.harness}.`,
        );
      }
    }
  }

  await runNamedScenario(
    "two-harness-proof-bundle",
    twoHarnessProofBundleScenario,
  );

  async function installCollisionScenario(): Promise<void> {
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
      [
        "bundle",
        "build",
        variantFolder,
        "--no-install",
        "--output",
        variantWfb,
      ],
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
  }

  await runNamedScenario("install-collision", installCollisionScenario);

  async function runRefusalsScenario(): Promise<void> {
    // Run error paths from the compiled binary (issue #82, AC7): `run show` on an
    // unknown Run id and `run launch` on an uninstalled Bundle each exit non-zero
    // with the precise Problem, before any Run directory exists.
    assertRefuses(binary, [
      {
        args: ["run", "show", "no-such-run"],
        match: "run-not-found",
        cwd: workspaceDirectory,
        env: workspaceEnv,
        detail: "did not print run-not-found",
      },
      {
        args: ["run", "launch", "io.example.absent"],
        match: "bundle-not-installed",
        cwd: workspaceDirectory,
        env: workspaceEnv,
        detail: "did not print bundle-not-installed",
      },
    ]);
  }

  await runNamedScenario("run-refusals", runRefusalsScenario);

  async function headlessRefusalFixturesScenario(): Promise<void> {
    // Preflight refusals from the compiled binary (issue #83, AC7; #116), each before
    // any Run exists. An interactive-agent Bundle is refused headlessly with
    // interactive-step-needs-tui (the headless client cannot relay human turn-taking,
    // checked before Harness discovery so it is deterministic without Claude Code); a
    // Command-only Bundle that requires a Git worktree root is refused with the
    // git-worktree-root Problem when launched from the non-repository workspace.
    // Neither needs a trust acknowledgement: Preflight runs ahead of the Trust gate.
    const interactiveFolder = join(smokeRoot, "interactive-bundle");
    await mkdir(interactiveFolder, { recursive: true });
    await writeFile(join(interactiveFolder, "grill.md"), "Grill me.\n");
    await writeFile(
      join(interactiveFolder, "manifest.json"),
      JSON.stringify({
        formatVersion: 1,
        bundle: {
          id: "dev.secant.smoke-interactive",
          version: "1.0.0",
          name: "Smoke Interactive",
          description: "An interactive-agent Bundle refused headlessly (#116).",
        },
        platforms: ["windows", "macos", "linux"],
        inputs: {},
        assets: [{ path: "grill.md", kind: "prompt" }],
        routing: [
          {
            id: "grill",
            kind: "interactive-agent",
            session: "s",
            prompt: { asset: "grill.md" },
          },
        ],
      }),
    );
    const interactiveWfb = join(smokeRoot, "interactive.wfb");
    run(
      binary,
      [
        "bundle",
        "build",
        interactiveFolder,
        "--no-install",
        "--output",
        interactiveWfb,
      ],
      { cwd: smokeRoot, env: workspaceEnv },
    );
    run(binary, ["bundle", "install", interactiveWfb], {
      cwd: smokeRoot,
      env: workspaceEnv,
    });

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
  }

  await runNamedScenario(
    "headless-refusal-fixtures",
    headlessRefusalFixturesScenario,
  );

  async function mattFrontRefusalScenario(): Promise<void> {
    // The maintained Matt front Bundle (#123): built and installed the way a user's
    // Bundle is (nothing in target source names its id), then refused headlessly with
    // the exact interactive-step-needs-tui code AND its remediation — the assertion
    // the M2 not-executable check was replaced by, now pointed at the Matt front. It
    // runs to succeeded only in the TUI (tests/tui/matt-front-workbench.test.tsx).
    const mattFrontFolder = join(projectRoot, "bundles", "matt-front-spec");
    const mattFrontWfb = join(smokeRoot, "matt-front.wfb");
    run(
      binary,
      [
        "bundle",
        "build",
        mattFrontFolder,
        "--no-install",
        "--output",
        mattFrontWfb,
      ],
      { cwd: smokeRoot, env: workspaceEnv },
    );
    run(binary, ["bundle", "install", mattFrontWfb], {
      cwd: smokeRoot,
      env: workspaceEnv,
    });
    {
      const refused = spawnSync(
        binary,
        ["run", "launch", "dev.secant.matt-front"],
        { cwd: workspaceDirectory, encoding: "utf8", env: workspaceEnv },
      );
      if (refused.error) throw refused.error;
      const output = `${refused.stdout}${refused.stderr}`;
      if (
        refused.status === 0 ||
        !output.includes("interactive-step-needs-tui") ||
        !output.includes("Run this Bundle in the TUI.")
      ) {
        throw new Error(
          `The Matt front was not refused headlessly with the interactive-step-needs-tui code and its remediation: ${output}`,
        );
      }
    }
  }

  await runNamedScenario("matt-front-refusal", mattFrontRefusalScenario);

  async function preflightRefusalsScenario(): Promise<void> {
    assertRefuses(binary, [
      {
        args: ["run", "launch", "dev.secant.smoke-interactive"],
        match: "interactive-step-needs-tui",
        cwd: workspaceDirectory,
        env: workspaceEnv,
        detail:
          "did not report a Preflight refusal (interactive-step-needs-tui)",
      },
      {
        args: ["run", "launch", "dev.secant.git-guard"],
        match: "git-worktree-root",
        cwd: workspaceDirectory,
        env: workspaceEnv,
        detail: "did not report a Preflight refusal (git-worktree-root)",
      },
    ]);
  }

  await runNamedScenario("preflight-refusals", preflightRefusalsScenario);

  // The pre-launch assessment from the compiled binary (issue #189, AC5/AC8): a
  // draft with several faults — a required input unprovided AND the digest
  // untrusted — is read through `launch-preparation` first, so `run launch` prints
  // every finding (text and JSON) and exits without submitting. No Harness is
  // needed: the assessment is not-ready before any qualification, so this stays
  // deterministic without Claude Code and creates no Run.
  async function launchPreparationHeadlessScenario(): Promise<void> {
    const runtime = basename(process.execPath);
    const folder = join(smokeRoot, "lp-smoke-bundle");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify({
        formatVersion: 1,
        bundle: {
          id: "dev.secant.lp-smoke",
          version: "1.0.0",
          name: "LP Smoke",
          description: "Pre-launch assessment smoke Bundle (#189).",
        },
        platforms: ["windows", "macos", "linux"],
        inputs: { note: { type: "text", description: "a required note" } },
        assets: [],
        routing: [
          {
            id: "run",
            kind: "command",
            command: {
              executable: runtime,
              arguments: ["-e", "process.exit(0)"],
            },
          },
        ],
      }),
    );
    const wfb = join(smokeRoot, "lp-smoke.wfb");
    run(binary, ["bundle", "build", folder, "--no-install", "--output", wfb], {
      cwd: smokeRoot,
      env: workspaceEnv,
    });
    run(binary, ["bundle", "install", wfb], {
      cwd: smokeRoot,
      env: workspaceEnv,
    });

    const text = spawnSync(binary, ["run", "launch", "dev.secant.lp-smoke"], {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: workspaceEnv,
    });
    if (text.error) throw text.error;
    const output = `${text.stdout}${text.stderr}`;
    if (
      text.status === 0 ||
      !output.includes("launch-input-invalid") ||
      !output.includes("bundle-trust-required")
    ) {
      throw new Error(
        `run launch on a not-ready draft did not print every finding and exit non-zero: ${output}`,
      );
    }

    const json = spawnSync(
      binary,
      ["run", "launch", "dev.secant.lp-smoke", "--json"],
      { cwd: workspaceDirectory, encoding: "utf8", env: workspaceEnv },
    );
    if (json.error) throw json.error;
    if (json.status === 0) {
      throw new Error(
        `run launch --json on a not-ready draft exited zero: ${json.stdout}${json.stderr}`,
      );
    }
    const parsed = JSON.parse(json.stdout) as {
      status?: string;
      findings?: unknown[];
    };
    if (
      parsed.status !== "not-ready" ||
      !Array.isArray(parsed.findings) ||
      parsed.findings.length < 2
    ) {
      throw new Error(
        `run launch --json did not report a not-ready assessment with all findings: ${json.stdout}`,
      );
    }
  }

  await runNamedScenario(
    "launch-preparation-headless",
    launchPreparationHeadlessScenario,
  );

  // Workspace materialization, verification, conflict, and resume from the
  // compiled binary on each gated OS (issue #88, AC6). A `home: workspace` text
  // Artifact is materialized to its declared path; a middle Step modifies that
  // copy; the next Step's byte-for-byte verify rests the Run `halted` with a
  // conflict `run show` names; restoring the file and `run resume` continues it.
  async function workspaceMaterializationScenario(): Promise<void> {
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
    const installed = await buildAndInstall(
      binary,
      join(smokeRoot, "materialize-bundle"),
      manifest,
      {
        build: smokeRoot,
        list: workspaceDirectory,
        env: workspaceEnv,
        label: "Materialization",
      },
    );

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
    const resumed = run(binary, ["run", "resume", runId], {
      cwd: workspaceDirectory,
      env: workspaceEnv,
    });
    if (!resumed.includes("State: succeeded")) {
      throw new Error(
        `Resuming after restoring the file did not continue the Run: ${resumed}`,
      );
    }
  }

  await runNamedScenario(
    "workspace-materialization",
    workspaceMaterializationScenario,
  );

  // Answer a durable Human Gate across process invocations from the compiled
  // binary on each gated OS (issue #85, AC6). A Repeat group blocks at its Review
  // checkpoint under one invocation; a second, separate invocation answers the
  // Gate `--continue`, granting one more interval that reaches the pass and rests
  // the Run `succeeded` — the answer survived process death as a durable Artifact.
  async function durableHumanGateScenario(): Promise<void> {
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
    const installed = await buildAndInstall(
      binary,
      join(smokeRoot, "answer-bundle"),
      manifest,
      {
        build: smokeRoot,
        list: workspaceDirectory,
        env: workspaceEnv,
        label: "Answer",
      },
    );

    // First invocation: launch, which blocks at the checkpoint and exits 2 (A36).
    const launched = run(
      binary,
      ["run", "launch", id, "--trust", installed.digest, "--json"],
      { cwd: workspaceDirectory, env: workspaceEnv, expect: 2 },
    );
    const launchSnapshot = JSON.parse(launched);
    const runId = launchSnapshot.runId;
    if (launchSnapshot.result.run.state !== "blocked") {
      throw new Error(
        `Expected the Run to rest blocked at the checkpoint: ${launched}`,
      );
    }

    // Second, separate invocation: answer the durable Gate `--continue`; it runs
    // to succeeded and exits 0.
    const answered = run(binary, ["run", "answer", runId, "--continue"], {
      cwd: workspaceDirectory,
      env: workspaceEnv,
    });
    if (!answered.includes("State: succeeded")) {
      throw new Error(
        `Answering --continue in a fresh invocation did not resolve the Run: ${answered}`,
      );
    }
  }

  await runNamedScenario("durable-human-gate", durableHumanGateScenario);

  // List, delete, and refuse-cancel Previous Runs from the compiled binary on each
  // gated OS (issue #87, AC6). The materialize and answer scenarios above left two
  // resting Runs in this Workspace's group; list them, delete one, and confirm a
  // resting Run cannot be cancelled.
  async function runListAndDeleteScenario(): Promise<void> {
    const listed = JSON.parse(
      run(binary, ["run", "list", "--json"], {
        cwd: workspaceDirectory,
        env: workspaceEnv,
      }),
    );
    if (!Array.isArray(listed.rows) || listed.rows.length < 2) {
      throw new Error(
        `run list --json did not carry the earlier Runs: ${JSON.stringify(listed)}`,
      );
    }
    // Each row is grouped into a valid day bucket (not asserting "today", which is
    // local-midnight sensitive between the Runs' creation and this list).
    if (
      listed.rows.some(
        (row: { group: string; runId: string; live: boolean }) =>
          !["today", "yesterday", "older"].includes(row.group),
      )
    ) {
      throw new Error(
        `run list --json produced an invalid day group: ${JSON.stringify(listed)}`,
      );
    }
    const [victim, survivor] = listed.rows;

    const deleted = run(binary, ["run", "delete", victim.runId], {
      cwd: workspaceDirectory,
      env: workspaceEnv,
    });
    if (!deleted.includes(`Deleted run ${victim.runId}`)) {
      throw new Error(`run delete did not confirm the removal: ${deleted}`);
    }
    const afterDelete = JSON.parse(
      run(binary, ["run", "list", "--json"], {
        cwd: workspaceDirectory,
        env: workspaceEnv,
      }),
    );
    if (
      afterDelete.rows.some(
        (row: { group: string; runId: string; live: boolean }) =>
          row.runId === victim.runId,
      )
    ) {
      throw new Error(
        `The deleted Run still appears in run list: ${JSON.stringify(afterDelete)}`,
      );
    }

    // A resting Run cannot be cancelled: exits non-zero with the precise Problem.
    const cancel = spawnSync(binary, ["run", "cancel", survivor.runId], {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: workspaceEnv,
    });
    if (cancel.error) throw cancel.error;
    if (
      cancel.status === 0 ||
      !`${cancel.stdout}${cancel.stderr}`.includes("run-not-live")
    ) {
      throw new Error(
        `Cancelling a resting Run was not refused: ${cancel.stdout}${cancel.stderr}`,
      );
    }
  }

  await runNamedScenario("run-list-and-delete", runListAndDeleteScenario);

  // A headless process interrupted by SIGINT mid-Run rests the Run `halted` and a
  // later `run resume` continues it, on each gated OS (issue #98, AC3). A dedicated
  // home and Workspace isolate the one Run, so the reopen lists exactly it. The
  // Bundle's middle Step writes a `started` marker (and its own pid) then sleeps
  // until killed — unless a `proceed` marker exists, when it exits at once, so the
  // resume completes without sleeping. On POSIX the binary's signal handler aborts
  // the live Run (killing the child's group) and leaves the claim live; on Windows
  // SIGINT is uncatchable and terminates the process, leaving the same live claim —
  // either way the next open reconciles the Run `halted`.
  async function signalHaltThenResumeScenario(): Promise<void> {
    const sigintHome = join(smokeRoot, "sigint-home");
    const sigintWorkspace = join(smokeRoot, "sigint-workspace");
    await mkdir(sigintWorkspace, { recursive: true });
    const sigintEnv = homeEnv(sigintHome);
    const runtime = basename(process.execPath);
    const markerDir = join(smokeRoot, "sigint-markers");
    await mkdir(markerDir, { recursive: true });
    const startedMarker = join(markerDir, "started");
    const proceedMarker = join(markerDir, "proceed");
    const lastMarker = join(markerDir, "last");
    const q = (value: unknown) => JSON.stringify(value);
    const id = "dev.secant.sigint-smoke";
    const manifest = {
      formatVersion: 1,
      bundle: {
        id,
        version: "1.0.0",
        name: "SIGINT Smoke",
        description: "A SIGINT-recovery smoke Bundle.",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [],
      routing: [
        {
          id: "block",
          kind: "command",
          produces: [{ name: "t1", type: "text" }],
          command: {
            executable: runtime,
            arguments: [
              "-e",
              `const fs=require('node:fs');` +
                `fs.writeFileSync(${q(startedMarker)}, String(process.pid));` +
                `if(fs.existsSync(${q(proceedMarker)}))process.exit(0);` +
                `setTimeout(()=>process.exit(0), 30000);`,
            ],
          },
        },
        {
          id: "last",
          kind: "command",
          produces: [{ name: "t2", type: "text" }],
          command: {
            executable: runtime,
            arguments: [
              "-e",
              `require('node:fs').writeFileSync(${q(lastMarker)}, 'ran')`,
            ],
          },
        },
      ],
    };
    run(binary, ["workspace", "approve"], {
      cwd: sigintWorkspace,
      env: sigintEnv,
    });
    const installed = await buildAndInstall(
      binary,
      join(smokeRoot, "sigint-bundle"),
      manifest,
      {
        build: sigintWorkspace,
        list: sigintWorkspace,
        env: sigintEnv,
        label: "SIGINT smoke",
      },
    );

    // A real child launches the Run and blocks in the `block` Step's sleep.
    const child = spawn(
      binary,
      ["run", "launch", id, "--trust", installed.digest],
      { cwd: sigintWorkspace, env: sigintEnv },
    );
    const childErr: string[] = [];
    child.stderr.on("data", (d) => childErr.push(d.toString()));
    child.stdout.on("data", () => {});
    const exited = new Promise<void>((resolve) =>
      child.on("exit", () => resolve()),
    );

    const started = await waitForFile(startedMarker, 20000);
    if (!started) {
      child.kill("SIGKILL");
      throw new Error(
        `SIGINT smoke child never reached the block Step: ${childErr.join("")}`,
      );
    }

    // Interrupt the live Run with SIGINT, then wait for the process to exit.
    child.kill("SIGINT");
    await exited;
    // Defensively kill the block grandchild by the pid it wrote, so no orphan
    // lingers if the platform did not deliver the abort to its group (e.g. Windows).
    const blockPid = Number(readFileSync(startedMarker, "utf8").trim());
    if (Number.isInteger(blockPid) && blockPid > 0) {
      try {
        process.kill(blockPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }

    // Reopen the home: `run list` reconciles the interrupted Run to `halted`.
    const listed = JSON.parse(
      run(binary, ["run", "list", "--json"], {
        cwd: sigintWorkspace,
        env: sigintEnv,
      }),
    );
    if (!Array.isArray(listed.rows) || listed.rows.length !== 1) {
      throw new Error(
        `SIGINT smoke expected exactly one Run after the interrupt: ${JSON.stringify(listed)}`,
      );
    }
    const runId = listed.rows[0].runId;
    const shown = run(binary, ["run", "show", runId], {
      cwd: sigintWorkspace,
      env: sigintEnv,
    });
    if (!/State: halted/.test(shown)) {
      throw new Error(
        `SIGINT smoke Run did not rest halted after the interrupt: ${shown}`,
      );
    }
    if (existsSync(lastMarker)) {
      throw new Error("SIGINT smoke ran the final Step before the resume.");
    }

    // Let the interrupted Step complete at once on resume, then resume: it continues.
    await writeFile(proceedMarker, "go");
    const resumed = run(binary, ["run", "resume", runId], {
      cwd: sigintWorkspace,
      env: sigintEnv,
    });
    if (!resumed.includes("State: succeeded")) {
      throw new Error(
        `Resuming a SIGINT-interrupted Run did not continue it: ${resumed}`,
      );
    }
    if (!existsSync(lastMarker)) {
      throw new Error("SIGINT smoke resume did not run the final Step.");
    }

    // Launch the same blocking Bundle again and exercise the cross-process
    // resume contract from the installed binary. A plain resume names the live
    // owner; --takeover fences that process and continues from durable state.
    await rm(startedMarker, { force: true });
    await rm(proceedMarker, { force: true });
    await rm(lastMarker, { force: true });
    const ownedChild = spawn(
      binary,
      ["run", "launch", id, "--trust", installed.digest],
      { cwd: sigintWorkspace, env: sigintEnv },
    );
    const ownedErr: string[] = [];
    ownedChild.stderr.on("data", (data) => ownedErr.push(data.toString()));
    ownedChild.stdout.on("data", () => {});
    const ownedExited = new Promise<void>((resolve) =>
      ownedChild.on("exit", () => resolve()),
    );
    if (!(await waitForFile(startedMarker, 20000))) {
      ownedChild.kill("SIGKILL");
      throw new Error(
        `Takeover smoke child never reached the block Step: ${ownedErr.join("")}`,
      );
    }
    const liveRows = JSON.parse(
      run(binary, ["run", "list", "--json"], {
        cwd: sigintWorkspace,
        env: sigintEnv,
      }),
    ).rows;
    const ownedRun = liveRows.find(
      (row: { group: string; runId: string; live: boolean }) =>
        row.live === true,
    );
    if (ownedRun === undefined || typeof ownedRun.ownerPid !== "number") {
      throw new Error(
        `Takeover smoke did not list the owned Run live: ${JSON.stringify(liveRows)}`,
      );
    }
    const ownedBlockPid = Number(readFileSync(startedMarker, "utf8").trim());
    const refused = spawnSync(binary, ["run", "resume", ownedRun.runId], {
      cwd: sigintWorkspace,
      encoding: "utf8",
      env: sigintEnv,
    });
    if (refused.error) throw refused.error;
    const refusalText = `${refused.stdout}${refused.stderr}`;
    if (
      refused.status !== 1 ||
      !refusalText.includes("run-live-elsewhere") ||
      !refusalText.includes(String(ownedRun.ownerPid))
    ) {
      throw new Error(
        `Plain resume did not name the live owner: ${refusalText}`,
      );
    }

    await writeFile(proceedMarker, "go");
    const takeover = run(
      binary,
      ["run", "resume", ownedRun.runId, "--takeover"],
      { cwd: sigintWorkspace, env: sigintEnv },
    );
    if (!takeover.includes("State: succeeded")) {
      throw new Error(`Takeover did not continue the Run: ${takeover}`);
    }

    // Stop the fenced process and verify its cleanup cannot overwrite or release
    // the takeover result.
    ownedChild.kill("SIGINT");
    await ownedExited;
    if (Number.isInteger(ownedBlockPid) && ownedBlockPid > 0) {
      try {
        process.kill(ownedBlockPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    const afterTakeover = run(binary, ["run", "show", ownedRun.runId], {
      cwd: sigintWorkspace,
      env: sigintEnv,
    });
    if (!/State: succeeded/.test(afterTakeover)) {
      throw new Error(
        `The fenced owner changed the takeover result: ${afterTakeover}`,
      );
    }
  }

  await runNamedScenario(
    "signal-halt-then-resume",
    signalHaltThenResumeScenario,
  );

  // #86 through the installed binary on every OS: a Run's owner is KILLED
  // (SIGKILL — uncatchable, so no signal handler runs and the claim is left live
  // at a now-dead pid, exactly like a crash), a later invocation reconciles the Run
  // `halted`, and a plain `resume` (no `--takeover`, because nothing is live) recovers
  // it from durable state with no earlier Step re-run. This is the one compiled-binary
  // home for the owner-death recovery path; the process-free suite never spawns.
  async function ownerDeathRecoveryScenario(): Promise<void> {
    const home = join(smokeRoot, "owner-death-home");
    const workspace = join(smokeRoot, "owner-death-workspace");
    await mkdir(workspace, { recursive: true });
    const env = homeEnv(home);
    const runtime = basename(process.execPath);
    const markerDir = join(smokeRoot, "owner-death-markers");
    await mkdir(markerDir, { recursive: true });
    const firstMarker = join(markerDir, "first");
    const startedMarker = join(markerDir, "started");
    const proceedMarker = join(markerDir, "proceed");
    const lastMarker = join(markerDir, "last");
    const q = (value: unknown) => JSON.stringify(value);
    const id = "dev.secant.owner-death-smoke";
    const manifest = {
      formatVersion: 1,
      bundle: {
        id,
        version: "1.0.0",
        name: "Owner Death Smoke",
        description: "An owner-death-recovery smoke Bundle.",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [],
      routing: [
        {
          id: "first",
          kind: "command",
          produces: [{ name: "t0", type: "text" }],
          command: {
            executable: runtime,
            // Append one line, so a re-run would leave two — proving the resume
            // continues from the killed Step, not from the start.
            arguments: [
              "-e",
              `require('node:fs').appendFileSync(${q(firstMarker)}, 'ran\\n')`,
            ],
          },
        },
        {
          id: "block",
          kind: "command",
          produces: [{ name: "t1", type: "text" }],
          command: {
            executable: runtime,
            arguments: [
              "-e",
              `const fs=require('node:fs');` +
                `fs.writeFileSync(${q(startedMarker)}, String(process.pid));` +
                `if(fs.existsSync(${q(proceedMarker)}))process.exit(0);` +
                `setTimeout(()=>process.exit(0), 30000);`,
            ],
          },
        },
        {
          id: "last",
          kind: "command",
          produces: [{ name: "t2", type: "text" }],
          command: {
            executable: runtime,
            arguments: [
              "-e",
              `require('node:fs').writeFileSync(${q(lastMarker)}, 'ran')`,
            ],
          },
        },
      ],
    };
    run(binary, ["workspace", "approve"], { cwd: workspace, env });
    const installed = await buildAndInstall(
      binary,
      join(smokeRoot, "owner-death-bundle"),
      manifest,
      { build: workspace, list: workspace, env, label: "owner-death smoke" },
    );

    // A real child launches the Run and blocks in the `block` Step's sleep.
    const child = spawn(
      binary,
      ["run", "launch", id, "--trust", installed.digest],
      {
        cwd: workspace,
        env,
      },
    );
    const childErr: string[] = [];
    child.stderr.on("data", (d) => childErr.push(d.toString()));
    child.stdout.on("data", () => {});
    const exited = new Promise<void>((resolve) =>
      child.on("exit", () => resolve()),
    );
    if (!(await waitForFile(startedMarker, 20000))) {
      child.kill("SIGKILL");
      throw new Error(
        `Owner-death smoke child never reached the block Step: ${childErr.join("")}`,
      );
    }

    // Kill the owner uncatchably (never a cancel): the claim is left live at the
    // dead pid, exactly like a crash. Then reap the orphaned block grandchild by
    // the pid it wrote, so nothing lingers.
    child.kill("SIGKILL");
    await exited;
    const blockPid = Number(readFileSync(startedMarker, "utf8").trim());
    if (Number.isInteger(blockPid) && blockPid > 0) {
      try {
        process.kill(blockPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }

    // A fresh invocation reconciles the dead owner's Run to `halted` and runs no
    // Step work while doing so.
    const listed = JSON.parse(
      run(binary, ["run", "list", "--json"], { cwd: workspace, env }),
    );
    if (!Array.isArray(listed.rows) || listed.rows.length !== 1) {
      throw new Error(
        `Owner-death smoke expected exactly one Run after the kill: ${JSON.stringify(listed)}`,
      );
    }
    const runId = listed.rows[0].runId;
    const shown = run(binary, ["run", "show", runId], { cwd: workspace, env });
    if (!/State: halted/.test(shown)) {
      throw new Error(
        `Owner-death smoke Run did not rest halted after the kill: ${shown}`,
      );
    }
    if (readFileSync(firstMarker, "utf8") !== "ran\n") {
      throw new Error(
        `Owner-death smoke re-ran the first Step during recovery: ${readFileSync(firstMarker, "utf8")}`,
      );
    }
    if (existsSync(lastMarker)) {
      throw new Error(
        "Owner-death smoke ran the final Step before the resume.",
      );
    }

    // Recover with a plain resume (no --takeover — the owner is dead): it continues
    // from the killed Step to completion, re-running no earlier Step.
    await writeFile(proceedMarker, "go");
    const resumed = run(binary, ["run", "resume", runId], {
      cwd: workspace,
      env,
    });
    if (!resumed.includes("State: succeeded")) {
      throw new Error(
        `Recovering a killed Run's owner did not continue it: ${resumed}`,
      );
    }
    if (readFileSync(firstMarker, "utf8") !== "ran\n") {
      throw new Error(
        `Owner-death smoke re-ran the first Step on resume: ${readFileSync(firstMarker, "utf8")}`,
      );
    }
    if (!existsSync(lastMarker)) {
      throw new Error("Owner-death smoke resume did not run the final Step.");
    }
  }

  await runNamedScenario("owner-death-recovery", ownerDeathRecoveryScenario);

  // The maintained Command-only gate Bundle, built, installed, and run to
  // completion from the compiled binary on each gated OS (issue #89, the M2 gate —
  // ADR 0027, #26). Its Repeat loop's check fails on iterations 1 and 2 and passes
  // on iteration 3, keeping its count in the Workspace; the Review checkpoint
  // interval is 2, so it blocks once after iteration 2 and the granted interval
  // reaches the pass — the Run blocks exactly once. The git-worktree-root
  // prerequisite runs the real Git probe from the binary on every OS. Nothing in
  // target source knows this Bundle exists — it is built, installed, and driven the
  // way a user's Bundle is.
  async function commandGateScenario(): Promise<void> {
    const gateId = "dev.secant.command-gate";
    const gateFolder = join(projectRoot, "bundles", "command-gate");
    const gateWfb = join(smokeRoot, "command-gate.wfb");
    run(
      binary,
      ["bundle", "build", gateFolder, "--no-install", "--output", gateWfb],
      { cwd: smokeRoot, env: workspaceEnv },
    );
    run(binary, ["bundle", "install", gateWfb], {
      cwd: smokeRoot,
      env: workspaceEnv,
    });
    const gate = JSON.parse(
      run(binary, ["bundle", "list", "--json"], {
        cwd: smokeRoot,
        env: workspaceEnv,
      }),
    ).result.bundles.find((bundle: { id: string }) => bundle.id === gateId);
    if (gate === undefined) {
      throw new Error("The gate Bundle was not installed.");
    }

    // A real Git worktree as the launch Workspace, approved, so the
    // git-worktree-root prerequisite passes. `git init` alone (an unborn worktree)
    // qualifies; the probe compares the canonicalized toplevel to the Workspace.
    const gateWorkspace = join(smokeRoot, "gate-workspace");
    await mkdir(gateWorkspace, { recursive: true });
    run("git", ["init"], { cwd: gateWorkspace });
    run(binary, ["workspace", "approve"], {
      cwd: gateWorkspace,
      env: workspaceEnv,
    });

    // Launch without acknowledgement: Preflight passes in the worktree, so Trust
    // refuses with the exact Problem — and no Run is created.
    const untrusted = spawnSync(binary, ["run", "launch", gateId], {
      cwd: gateWorkspace,
      encoding: "utf8",
      env: workspaceEnv,
    });
    if (untrusted.error) throw untrusted.error;
    if (
      untrusted.status === 0 ||
      !`${untrusted.stdout}${untrusted.stderr}`.includes(
        "bundle-trust-required",
      )
    ) {
      throw new Error(
        `Launching the gate Bundle without --trust was not refused with the trust Problem: ${untrusted.stdout}${untrusted.stderr}`,
      );
    }
    const beforeLaunch = JSON.parse(
      run(binary, ["run", "list", "--json"], {
        cwd: gateWorkspace,
        env: workspaceEnv,
      }),
    );
    if (beforeLaunch.rows.length !== 0) {
      throw new Error(
        `The refused launch created a Run: ${JSON.stringify(beforeLaunch)}`,
      );
    }

    // Launch with the exact digest acknowledged: the loop runs and rests `blocked`
    // at the checkpoint (exit 2, A36) with the expected completed-iteration count.
    const launched = run(
      binary,
      ["run", "launch", gateId, "--trust", gate.digest, "--json"],
      { cwd: gateWorkspace, env: workspaceEnv, expect: 2 },
    );
    const gateSnapshot = JSON.parse(launched);
    const gateRunId = gateSnapshot.runId;
    const gateRun = gateSnapshot.result.run;
    if (gateRun.state !== "blocked") {
      throw new Error(
        `Expected the gate Run to rest blocked at the checkpoint: ${launched}`,
      );
    }
    if (gateRun.checkpoint?.completedIterations !== 2) {
      throw new Error(
        `Expected the gate Run to block after 2 completed iterations: ${launched}`,
      );
    }

    // A second, separate invocation answers the durable Gate --continue, granting
    // one more interval that reaches the pass and rests the Run `succeeded`.
    const answered = run(binary, ["run", "answer", gateRunId, "--continue"], {
      cwd: gateWorkspace,
      env: workspaceEnv,
    });
    if (!answered.includes("State: succeeded")) {
      throw new Error(
        `Answering the gate Run --continue did not resolve it: ${answered}`,
      );
    }

    // Read the passing Command output by its reference: the last (passing)
    // iteration's captured log.
    const gateOutput = run(binary, ["run", "read", `${gateRunId}/log`], {
      cwd: gateWorkspace,
      env: workspaceEnv,
    });
    if (!gateOutput.includes("gate iteration 3 of 3")) {
      throw new Error(
        `run read did not return the passing gate output: ${gateOutput}`,
      );
    }

    // The completed Run appears in this Workspace's Previous Runs.
    const gateList = JSON.parse(
      run(binary, ["run", "list", "--json"], {
        cwd: gateWorkspace,
        env: workspaceEnv,
      }),
    );
    if (
      !gateList.rows.some(
        (row: { group: string; runId: string; live: boolean }) =>
          row.runId === gateRunId,
      )
    ) {
      throw new Error(
        `The gate Run does not appear in run list: ${JSON.stringify(gateList)}`,
      );
    }

    // Launching from a non-repository directory fails Preflight naming the
    // unmet git-worktree-root prerequisite, before Trust and before any Run.
    const nonRepo = join(smokeRoot, "gate-non-repo");
    await mkdir(nonRepo, { recursive: true });
    run(binary, ["workspace", "approve"], { cwd: nonRepo, env: workspaceEnv });
    const outsideRepo = spawnSync(
      binary,
      ["run", "launch", gateId, "--trust", gate.digest],
      { cwd: nonRepo, encoding: "utf8", env: workspaceEnv },
    );
    if (outsideRepo.error) throw outsideRepo.error;
    if (
      outsideRepo.status === 0 ||
      !`${outsideRepo.stdout}${outsideRepo.stderr}`.includes(
        "git-worktree-root",
      )
    ) {
      throw new Error(
        `Launching the gate Bundle outside a Git worktree was not refused with git-worktree-root: ${outsideRepo.stdout}${outsideRepo.stderr}`,
      );
    }
  }

  await runNamedScenario("command-gate", commandGateScenario);

  const commandBundle = (
    id: string,
    name: string,
    executable: string,
    args: readonly string[] = [],
  ) => ({
    formatVersion: 1,
    bundle: { id, version: "1.0.0", name, description: `${name} smoke.` },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [],
    routing: [
      {
        id: "command-step",
        kind: "command",
        produces: [{ name: "v", type: "verdict" }],
        command: { executable, arguments: args },
      },
    ],
  });

  async function windowsCmdShimScenario(): Promise<void> {
    // Windows `.cmd` shim resolution (issue #96 A40, #26): a Bundle whose Command
    // step names an npm-style `.cmd` shim resolves through the shim to its real
    // target and runs to a Verdict without a shell; a Bundle naming a plain `.bat`
    // is refused at Preflight with the interpreter remediation. POSIX has no shim
    // rule (the executable resolves directly), so this case is Windows-only.
    if (process.platform !== "win32") return;

    const runtime = basename(process.execPath); // resolvable via workspaceEnv PATH
    const shimDir = join(smokeRoot, "shims");
    await mkdir(shimDir, { recursive: true });
    // The worker the npm-style shim wraps: exit 0 -> a pass Verdict.
    await writeFile(join(shimDir, "worker.js"), "process.exit(0)\n");
    // An npm `cmd-shim` shape: `_prog` is the interpreter (the runtime already on
    // PATH), invoked on the `%dp0%`-relative worker script.
    const cmdShim = [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "",
      `IF EXIST "%dp0%\\${runtime}" (`,
      `  SET "_prog=%dp0%\\${runtime}"`,
      ") ELSE (",
      `  SET "_prog=${runtime}"`,
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      "",
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\worker.js" %*`,
    ].join("\r\n");
    await writeFile(join(shimDir, "shimtool.cmd"), cmdShim);
    // A plain `.bat` that is not an npm-style shim: Preflight must refuse it.
    await writeFile(
      join(shimDir, "battool.bat"),
      "@echo off\r\necho not a node shim\r\n",
    );
    const shimEnv = {
      ...workspaceEnv,
      PATH: `${shimDir}${delimiter}${workspaceEnv.PATH ?? ""}`,
    };

    // The npm-style `.cmd` shim: Preflight passes and the Command runs to a Verdict.
    const okId = "dev.secant.cmd-shim-ok";
    const okInstalled = await buildAndInstall(
      binary,
      join(smokeRoot, "cmd-shim-ok"),
      commandBundle(okId, "Cmd Shim Ok", "shimtool"),
      {
        build: smokeRoot,
        list: workspaceDirectory,
        env: shimEnv,
        label: "cmd-shim-ok",
      },
    );
    const okLaunch = run(
      binary,
      ["run", "launch", okId, "--trust", okInstalled.digest, "--json"],
      { cwd: workspaceDirectory, env: shimEnv },
    );
    if (JSON.parse(okLaunch).result.run.state !== "succeeded") {
      throw new Error(
        `npm-style .cmd shim Command did not run to succeeded: ${okLaunch}`,
      );
    }

    // The plain `.bat`: refused at Preflight (before Trust) with the shim Problem.
    const batId = "dev.secant.cmd-shim-bat";
    await buildAndInstall(
      binary,
      join(smokeRoot, "cmd-shim-bat"),
      commandBundle(batId, "Cmd Shim Bat", "battool"),
      {
        build: smokeRoot,
        list: workspaceDirectory,
        env: shimEnv,
        label: "cmd-shim-bat",
      },
    );
    const batLaunch = spawnSync(binary, ["run", "launch", batId], {
      cwd: workspaceDirectory,
      encoding: "utf8",
      env: shimEnv,
    });
    if (batLaunch.error) throw batLaunch.error;
    if (batLaunch.status === 0) {
      throw new Error(
        "Launching a Bundle naming a plain .bat should be refused.",
      );
    }
    const batOutput = `${batLaunch.stdout}${batLaunch.stderr}`;
    if (!batOutput.includes("command-executable-unsupported-shim")) {
      throw new Error(
        `The .bat Bundle was not refused with the unsupported-shim Problem: ${batOutput}`,
      );
    }
  }

  await runNamedScenario("windows-cmd-shim", windowsCmdShimScenario);

  async function windowsAppExecutionAliasScenario(): Promise<void> {
    if (process.platform !== "win32") return;
    // A Windows Store/MSIX App Execution Alias is visible to where.exe and
    // spawnable by the OS, while the stat-based primary PATH walk cannot read its
    // AppExecLink. Exercise that exact Preflight fallback when the runner hosts
    // one; GitHub's Windows Server image does not promise any such alias.
    const alias = findWindowsAppExecutionAlias();
    if (alias === undefined) {
      console.warn(
        "Skipping App Execution Alias smoke: this Windows runner exposes no pwsh or winget alias that where.exe can see after the primary PATH walk misses.",
      );
      return;
    }

    const aliasId = "dev.secant.app-execution-alias";
    const aliasInstalled = await buildAndInstall(
      binary,
      join(smokeRoot, "app-execution-alias"),
      commandBundle(aliasId, "App Execution Alias", alias.name, alias.args),
      {
        build: smokeRoot,
        list: workspaceDirectory,
        env: workspaceEnv,
        label: "app-execution-alias",
      },
    );
    const aliasLaunch = run(
      binary,
      ["run", "launch", aliasId, "--trust", aliasInstalled.digest, "--json"],
      { cwd: workspaceDirectory, env: workspaceEnv },
    );
    if (JSON.parse(aliasLaunch).result.run.state !== "succeeded") {
      throw new Error(
        `App Execution Alias Command did not pass Preflight and run: ${aliasLaunch}`,
      );
    }
  }

  await runNamedScenario(
    "windows-app-execution-alias",
    windowsAppExecutionAliasScenario,
  );

  async function noInteractiveTerminalScenario(): Promise<void> {
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
  }

  await runNamedScenario(
    "no-interactive-terminal",
    noInteractiveTerminalScenario,
  );

  process.stdout.write(
    `Compiled binary smoke passed for ${source} (@secantdev/secant@${pkg.version}).\n`,
  );
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
