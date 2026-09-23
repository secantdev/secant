import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type Application,
  type ApplicationHarnessRegistration,
} from "../../src/application/application.js";
import { buildBundle, writeZip } from "../../src/bundle/bundle.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import type { RunGroup } from "../../src/run/store/store.js";
import {
  ensureRuntimeOnPath,
  hostPlatform,
  writeCommandBundle,
  type CommandBundleOptions,
} from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { readArchiveEntries } from "../helpers/zip.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import {
  createFakeGitProcess,
  openFakeRunGroup as openRunGroup,
} from "../run/store/fake-git-process.js";

// Preflight is exercised through the Application's Projection Port — the Module's
// public Interface — never by importing the private submodule (the boundary suite
// forbids it). Each failure asserts the Problem and that no Run and no Trust grant
// were left behind; the real Git worktree and PATH probes run over real temporary
// resources (testing.md).

ensureRuntimeOnPath();

type GitProbe =
  "pass" | "fail" | "subdirectory" | "unavailable" | "spawn-error";

interface Fixture {
  readonly app: Application;
  readonly catalog: Catalog;
  readonly runGroup: RunGroup;
  readonly workspace: string;
}

// A fixture whose launch Workspace is the given path (a real Git worktree, or a
// plain/bare directory), approved so the launch reaches Preflight.
function fixture(
  t: TestContext,
  workspace: string,
  harnessRegistry: readonly ApplicationHarnessRegistration[] = [],
  gitProbe: GitProbe = "pass",
): Fixture {
  const executionProcess = preflightProcess(workspace, gitProbe);
  const catalog = openCatalog(makeTempDir("secant-pf-home-"));
  t.after(() => catalog.close());
  const runGroup = openRunGroup(makeTempDir("secant-pf-store-"), workspace);
  t.after(() => runGroup.close());
  const app = createApplication({
    catalog,
    process: executionProcess,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    harnessRegistry,
    runExecution: ({ routing, owner }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process: executionProcess,
      }),
  });
  catalog.approveWorkspace(workspace, new Date());
  return { app, catalog, runGroup, workspace };
}

function preflightProcess(
  workspace: string,
  gitProbe: GitProbe,
): ProcessAdapter {
  const git = createFakeGitProcess();
  const commands = createFakeProcess({
    resolutionHandler: (name) =>
      name === "secant-no-such-binary-xyz" ||
      (name === "git" && gitProbe === "unavailable")
        ? { kind: "not-found" }
        : { kind: "found", executable: name, prefixArgs: [] },
    commandHandler: () => ({
      kind: "exited",
      status: 0,
      text: new Uint8Array(),
    }),
  });
  return {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => {
      if (options.args.includes("rev-parse")) {
        if (gitProbe === "spawn-error") {
          return { kind: "spawn-error", cause: new Error("cannot launch Git") };
        }
        const status = gitProbe === "fail" ? 1 : 0;
        const top =
          gitProbe === "subdirectory" ? dirname(workspace) : workspace;
        return {
          kind: "exited",
          status,
          stdout: new TextEncoder().encode(`${top}\n`),
          stderr: new Uint8Array(),
        };
      }
      return git.spawnCommandSync(options);
    },
  };
}

function workspace(): string {
  return realpathSync.native(makeTempDir("secant-pf-workspace-"));
}

function install(
  f: Fixture,
  options?: CommandBundleOptions,
): { id: string; digest: string } {
  const cmd = writeCommandBundle(options);
  const built = f.app.bundleManagement.build(cmd.folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((e) => e.id === cmd.id);
  assert.ok(entry);
  return { id: cmd.id, digest: entry.digest };
}

function installAgentBundle(f: Fixture): { id: string; digest: string } {
  const folder = makeTempDir("secant-pf-agent-");
  mkdirSync(join(folder, "prompts"));
  writeFileSync(join(folder, "prompts", "work.md"), "Do the work.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.preflight-agent",
      version: "1.0.0",
      name: "Preflight Agent",
      description: "Exercises semantic Harness selection.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/work.md", kind: "prompt" }],
    routing: [
      {
        id: "work",
        kind: "agent",
        session: "work",
        retry: 0,
        prompt: { asset: "prompts/work.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  const built = f.app.bundleManagement.build(folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((candidate) => {
    return candidate.id === manifest.bundle.id;
  });
  assert.ok(entry);
  return { id: entry.id, digest: entry.digest };
}

/** Await a launched Run's async settlement, so its execution finishes before the
 *  test's fixture closes the Run Store (execution spawns and settles off-thread). */
async function settled(f: Fixture, operationId: string): Promise<void> {
  await awaitSettled(f.app.projectionPort, operationId);
}

function launch(
  f: Fixture,
  id: string,
  extra: {
    trustDigest?: string;
    launchInputs?: Record<string, string>;
    harness?: string;
  } = {},
) {
  return f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: {
      bundle: { id },
      launchInputs: extra.launchInputs ?? {},
      harness: extra.harness,
      trustDigest: extra.trustDigest,
    },
  });
}

function registeredHarness(params: {
  id: "claude-code" | "codex";
  name: string;
  discover: ApplicationHarnessRegistration["discover"];
  availability?: "available" | "unavailable";
  unavailableReason?: string;
  servedCapabilities?: readonly string[];
}): ApplicationHarnessRegistration {
  return {
    choice: {
      id: params.id,
      name: params.name,
      availability: params.availability ?? "available",
      unavailableReason: params.unavailableReason,
    },
    servedCapabilities: params.servedCapabilities ?? [
      "agent-turn",
      "interactive-turns",
    ],
    discover: params.discover,
    qualify: async () => ({
      ok: false,
      failure: {
        phase: "prepare",
        category: "not-scripted",
        possibleEffects: "none",
      },
    }),
  };
}

// --- git-worktree-root probe ----------------------------------------------

for (const [label, gitProbe] of [
  ["a subdirectory of a worktree", "subdirectory"],
  ["a bare repository", "fail"],
  ["a plain directory", "fail"],
] as const) {
  test(`launching from ${label} fails git-worktree-root, no Run and no grant`, (t) => {
    const f = fixture(t, workspace(), [], gitProbe);
    const { id, digest } = install(f, { prerequisites: ["git-worktree-root"] });

    const admission = launch(f, id, { trustDigest: digest });
    assert.equal(admission.admitted, false);
    if (admission.admitted) throw new Error("unreachable");
    assert.equal(admission.problem.code, "workspace-prerequisite-failed");
    assert.equal(admission.problem.details?.prerequisite, "git-worktree-root");
    // A failed Preflight leaves no Run and no Trust grant.
    assert.deepEqual(f.runGroup.listRuns(), []);
    assert.equal(f.catalog.getTrustGrant(digest, 1), undefined);
  });
}

for (const label of [
  "a classic worktree root",
  "a linked worktree root",
  "an unborn worktree root",
] as const) {
  test(`launching from ${label} passes git-worktree-root`, (t) => {
    const f = fixture(t, workspace());
    const { id } = install(f, { prerequisites: ["git-worktree-root"] });

    // No trust acknowledgement: Preflight passes the git probe (and the PATH
    // check), so the launch reaches the Trust gate rather than a Preflight
    // Problem — proof the worktree qualifies.
    const admission = launch(f, id);
    assert.equal(admission.admitted, false);
    if (admission.admitted) throw new Error("unreachable");
    assert.equal(admission.problem.code, "bundle-trust-required");
  });
}

test("Git absent from PATH names Git as not runnable, no Run", (t) => {
  const f = fixture(t, workspace(), [], "unavailable");
  const { id, digest } = install(f, { prerequisites: ["git-worktree-root"] });

  const admission = launch(f, id, { trustDigest: digest });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "workspace-prerequisite-failed");
  assert.match(admission.problem.explanation, /not runnable/);
  assert.deepEqual(f.runGroup.listRuns(), []);
});

test("a Git spawn failure preserves its operational cause", (t) => {
  const f = fixture(t, workspace(), [], "spawn-error");
  const { id, digest } = install(f, {
    prerequisites: ["git-worktree-root"],
  });

  const admission = launch(f, id, { trustDigest: digest });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.ok(admission.problem.cause instanceof Error);
  assert.equal(admission.problem.cause.message, "cannot launch Git");
});

// --- command executable resolution ----------------------------------------

test("a Command whose executable is not on PATH is refused, no Run", (t) => {
  const f = fixture(t, workspace());
  const { id, digest } = install(f, {
    executable: "secant-no-such-binary-xyz",
  });

  const admission = launch(f, id, { trustDigest: digest });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "command-executable-not-found");
  assert.equal(admission.problem.details?.step, "run-check");
  assert.equal(
    admission.problem.details?.executable,
    "secant-no-such-binary-xyz",
  );
  assert.deepEqual(f.runGroup.listRuns(), []);
});

// --- Launch input validation ----------------------------------------------

test("missing or type-invalid Launch inputs yield one field violation per input, no Run", (t) => {
  const dir = makeTempDir("secant-pf-inputs-");
  const empty = join(dir, "empty.txt");
  writeFileSync(empty, "");
  const f = fixture(t, workspace());
  const { id, digest } = install(f, {
    inputs: {
      note: { type: "text", description: "a note" },
      report: { type: "file", description: "a file" },
      docs: { type: "file-set", description: "a file-set" },
      decision: { type: "verdict", description: "a verdict" },
      pick: { type: "choice", description: "a choice", choices: ["a", "b"] },
    },
  });

  const admission = launch(f, id, {
    trustDigest: digest,
    launchInputs: {
      // `note` omitted entirely → required-but-missing
      report: empty, // exists but empty → invalid file
      docs: "", // empty collection
      decision: "maybe", // not pass/fail
      pick: "c", // not a declared choice
    },
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "launch-input-invalid");
  const fields = (admission.problem.fieldViolations ?? []).map((v) => v.field);
  assert.equal(fields.length, 5);
  assert.deepEqual(
    new Set(fields),
    new Set(["note", "report", "docs", "decision", "pick"]),
  );
  assert.deepEqual(f.runGroup.listRuns(), []);
});

test("valid Launch inputs of every type pin to the created Run and are visible in run show", async (t) => {
  const dir = makeTempDir("secant-pf-valid-");
  const fileA = join(dir, "a.txt");
  writeFileSync(fileA, "a\n");
  const fileB = join(dir, "b.txt");
  writeFileSync(fileB, "b\n");
  const f = fixture(t, workspace());
  const { id, digest } = install(f, {
    inputs: {
      note: { type: "text", description: "a note" },
      report: { type: "file", description: "a file" },
      docs: { type: "file-set", description: "a file-set" },
      decision: { type: "verdict", description: "a verdict" },
      pick: { type: "choice", description: "a choice", choices: ["a", "b"] },
    },
  });

  const inputs = {
    note: "hello",
    report: fileA,
    docs: `${fileA}\n${fileB}`,
    decision: "pass",
    pick: "a",
  };
  const admission = launch(f, id, {
    trustDigest: digest,
    launchInputs: inputs,
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const record = f.runGroup.readRun(admission.runId!);
  assert.ok(record.ok);
  if (record.ok) assert.deepEqual(record.run.launch, inputs);
  // Let the launched Run settle before the fixture closes the Run Store.
  await settled(f, "op-1");
});

// --- Composition re-check (corrupted pinned Snapshot) ----------------------

test("a Snapshot failing the Composition re-check is refused as corrupted, no Run", (t) => {
  const f = fixture(t, workspace());

  // Build a valid command Bundle, then repack it with a manifest that is shape-
  // valid but no longer composes (a Step requires an artifact nothing binds), and
  // install those bytes directly. This is the corrupted-pinned-Snapshot case the
  // launch-time re-check exists for (a build never emits such bytes).
  const cmd = writeCommandBundle();
  const built = buildBundle(cmd.folder);
  assert.ok(built.ok, JSON.stringify(built));
  const entries = readArchiveEntries(built.built.bytes);
  const manifestEntry = entries.find((e) => e.path === "manifest.json");
  assert.ok(manifestEntry, "archive has a manifest.json");
  const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  manifest.routing[0].requires = ["ghost-artifact"]; // unbound → composition error
  const corruptBytes = writeZip(
    entries.map((e) =>
      e.path === "manifest.json"
        ? { path: e.path, data: Buffer.from(JSON.stringify(manifest)) }
        : { path: e.path, data: e.data },
    ),
  );
  const digest = createHash("sha256").update(corruptBytes).digest("hex");
  const result = f.catalog.installBundle({
    identity: { id: manifest.bundle.id, version: manifest.bundle.version },
    digest,
    bytes: corruptBytes,
    origin: { kind: "local-file", path: "corrupt.wfb" },
    installedAt: new Date(),
  });
  assert.equal(result.outcome, "installed");

  const admission = launch(f, manifest.bundle.id);
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "bundle-snapshot-corrupt");
  assert.match(admission.problem.remediation, /[Rr]einstall/);
  // No routing vocabulary leaks into the Problem the user sees.
  const shown = `${admission.problem.explanation} ${admission.problem.remediation}`;
  assert.doesNotMatch(shown, /ghost-artifact|unbound|run-check|artifact/);
  assert.deepEqual(f.runGroup.listRuns(), []);
});

// --- semantic Harness selection -------------------------------------------

test("[both-client-harness-selection] Agent launches require one known semantic Harness and discover only that choice", async (t) => {
  let claudeDiscoveries = 0;
  let codexDiscoveries = 0;
  const registry = [
    registeredHarness({
      id: "claude-code",
      name: "Claude Code",
      discover: () => {
        claudeDiscoveries++;
        return {
          kind: "found",
          source: "path",
          description: "PATH name 'claude'",
        };
      },
    }),
    registeredHarness({
      id: "codex",
      name: "Codex",
      discover: () => {
        codexDiscoveries++;
        return {
          kind: "found",
          source: "path",
          description: "PATH name 'codex'",
        };
      },
    }),
  ];
  const f = fixture(t, workspace(), registry);
  const { id, digest } = installAgentBundle(f);

  const missing = launch(f, id, { trustDigest: digest });
  assert.equal(missing.admitted, false);
  if (missing.admitted) throw new Error("unreachable");
  assert.equal(missing.problem.code, "harness-selection-required");

  const unknown = launch(f, id, {
    trustDigest: digest,
    harness: "gemini",
  });
  assert.equal(unknown.admitted, false);
  if (unknown.admitted) throw new Error("unreachable");
  assert.equal(unknown.problem.code, "harness-selection-unknown");

  const selected = launch(f, id, {
    trustDigest: digest,
    harness: "codex",
  });
  assert.ok(selected.admitted, JSON.stringify(selected));
  assert.equal(claudeDiscoveries, 0);
  assert.equal(codexDiscoveries, 1);
  const record = f.runGroup.readRun(selected.runId!);
  assert.ok(record.ok);
  assert.equal(record.run.selectedHarness, "codex");

  const changedReplay = f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: {
      bundle: { id },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
    },
  });
  assert.equal(changedReplay.admitted, false);
  if (changedReplay.admitted) throw new Error("unreachable");
  assert.equal(changedReplay.problem.code, "operation-id-reused");
  await settled(f, "op-1");
});

test("[both-client-harness-selection] Command-only launches reject a Harness without discovering one", (t) => {
  let discoveries = 0;
  const registry = [
    registeredHarness({
      id: "codex",
      name: "Codex",
      discover: () => {
        discoveries++;
        return {
          kind: "found",
          source: "path",
          description: "PATH name 'codex'",
        };
      },
    }),
  ];
  const f = fixture(t, workspace(), registry);
  const { id, digest } = install(f);
  const admission = launch(f, id, {
    trustDigest: digest,
    harness: "codex",
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "harness-selection-irrelevant");
  assert.equal(discoveries, 0);
  assert.deepEqual(f.runGroup.listRuns(), []);
});

test("an unavailable registered Harness is refused before discovery", (t) => {
  let discoveries = 0;
  const f = fixture(t, workspace(), [
    registeredHarness({
      id: "codex",
      name: "Codex",
      availability: "unavailable",
      unavailableReason: "disabled for this build",
      discover: () => {
        discoveries++;
        return {
          kind: "found",
          source: "path",
          description: "PATH name 'codex'",
        };
      },
    }),
  ]);
  const { id, digest } = installAgentBundle(f);
  const admission = launch(f, id, { trustDigest: digest, harness: "codex" });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "harness-selection-unavailable");
  assert.match(admission.problem.explanation, /disabled for this build/);
  assert.equal(discoveries, 0);
});

test("selected capability mismatch is refused before discovery", (t) => {
  let discoveries = 0;
  const f = fixture(t, workspace(), [
    registeredHarness({
      id: "codex",
      name: "Codex",
      servedCapabilities: [],
      discover: () => {
        discoveries++;
        return {
          kind: "found",
          source: "path",
          description: "PATH name 'codex'",
        };
      },
    }),
  ]);
  const { id, digest } = installAgentBundle(f);
  const admission = launch(f, id, { trustDigest: digest, harness: "codex" });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "harness-capability-unmet");
  assert.equal(discoveries, 0);
});

test("selected unsupported shim names the Harness and configured executable", (t) => {
  const f = fixture(t, workspace(), [
    registeredHarness({
      id: "codex",
      name: "Codex",
      discover: () => ({
        kind: "unsupported-shim",
        name: "codex",
        path: "C:\\bin\\codex.cmd",
        executableEnvironmentVariable: "SECANT_CODEX",
      }),
    }),
  ]);
  const { id, digest } = installAgentBundle(f);
  const admission = launch(f, id, { trustDigest: digest, harness: "codex" });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "harness-unsupported-shim");
  assert.equal(admission.problem.details?.harness, "codex");
  assert.match(admission.problem.remediation, /SECANT_CODEX/);
});

// --- intrinsic Step-kind precondition (the Proof Bundle) -------------------

test("the Proof Bundle's Agent Step is dispatchable and refused at Preflight when no Harness is found (#116)", (t) => {
  const f = fixture(t, workspace(), [
    registeredHarness({
      id: "claude-code",
      name: "Claude Code",
      discover: () => ({
        kind: "not-found",
        searched: ["PATH name 'claude': \"claude\""],
        executableEnvironmentVariable: "SECANT_CLAUDE_CODE",
      }),
    }),
  ]);
  const proofFolder = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "bundles",
    "test-repair-workflow",
  );
  const built = f.app.bundleManagement.build(proofFolder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog
    .listEntries()
    .find((e) => e.id === "dev.secant.test-repair")!;

  const admission = launch(f, entry.id, {
    trustDigest: entry.digest,
    harness: "claude-code",
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.deepEqual(admission.problem, {
    code: "harness-not-found",
    explanation:
      "This Bundle runs an agent through Claude Code, which could not be found. Searched: PATH name 'claude': \"claude\".",
    remediation:
      "Install Claude Code and make sure it is on PATH, or set SECANT_CLAUDE_CODE to its executable, then launch again.",
    possibleEffects: "none",
    correction: "harness",
    details: {
      harness: "claude-code",
      searched: "PATH name 'claude': \"claude\"",
    },
  });
  assert.deepEqual(f.runGroup.listRuns(), []);
});

test("a headless launch refuses an interactive-agent Bundle with interactive-step-needs-tui (#116)", (t) => {
  const f = fixture(t, workspace());
  // An interactive-agent Bundle authored directly (no command-bundle helper covers
  // it): the headless client cannot relay human turn-taking, so Preflight refuses
  // it with the TUI remedy — the only kind-based refusal now that every kind
  // dispatches (#122) — before any Harness discovery.
  const folder = makeTempDir("secant-interactive-bundle-");
  writeFileSync(join(folder, "grill.md"), "Grill me.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.interactive",
      version: "1.0.0",
      name: "Interactive",
      description: "An interactive-agent Bundle refused headlessly.",
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
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  const built = f.app.bundleManagement.build(folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog
    .listEntries()
    .find((e) => e.id === "dev.secant.interactive")!;

  const admission = launch(f, entry.id, { trustDigest: entry.digest });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "interactive-step-needs-tui");
  assert.equal(admission.problem.details?.step, "grill");
  assert.match(admission.problem.remediation, /TUI/i);
  assert.deepEqual(f.runGroup.listRuns(), []);
});
