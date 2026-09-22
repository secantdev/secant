import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type Application,
  type ApplicationHarnessQualification,
  type ApplicationHarnessRegistration,
} from "../../src/application/application.js";
import { buildBundle, writeZip } from "../../src/bundle/bundle.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import type { HarnessProfile } from "../../src/harness/harness.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import type {
  LaunchPreparationSnapshot,
  LaunchRunInput,
  LaunchRunOffer,
} from "../../src/application/projection-port.js";
import type { RunGroup } from "../../src/run/store/store.js";
import {
  ensureRuntimeOnPath,
  hostPlatform,
  writeCommandBundle,
  type CommandBundleOptions,
} from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { readArchiveEntries } from "../helpers/zip.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import {
  createFakeGitProcess,
  openFakeRunGroup as openRunGroup,
} from "../run/store/fake-git-process.js";

// `launch-preparation` (#189) exercised through the Application's Projection Port
// with the fake Process and a literal Harness registration array whose discover and
// qualify results are scripted. Each assessment proves its status, ordered findings
// and correction targets, that no Run, Trust grant, Session, or Turn is left behind,
// and — for a draft assessed ready — that a later launch reruns every authoritative
// check. Mirrors the Preflight and harness-catalog Port suites (testing.md).

ensureRuntimeOnPath();

type GitProbe = "pass" | "fail" | "unavailable";

interface Fixture {
  readonly app: Application;
  readonly catalog: Catalog;
  readonly runGroup: RunGroup;
  readonly workspace: string;
}

function listProfile(models: readonly string[]): HarnessProfile {
  return {
    harness: "Codex",
    executable: "/tools/codex",
    executableVersion: "1.2.3",
    platform: "linux",
    adapterRevision: "lp-test-v1",
    configurationPosture: "Uses the user's existing Codex configuration.",
    recovery: { mode: "native-reattach", evidence: "scripted" },
    interruption: { mode: "active-turn", evidence: "scripted" },
    approvals: { available: true, evidence: "scripted" },
    clarifications: { available: true, evidence: "scripted" },
    steer: { available: true, evidence: "scripted" },
    modelSelection: {
      at: "launch",
      declaration: { kind: "list", models },
      evidence: "Observed from model/list.",
    },
    modelObservation: { available: true, evidence: "scripted" },
    recoveryCoordinate: { timing: "before-submission", evidence: "scripted" },
    skillDelivery: { mode: "plain-path", evidence: "scripted" },
    fileDelivery: { mode: "plain-path", evidence: "scripted" },
  };
}

function registeredHarness(params: {
  id: "claude-code" | "codex";
  name: string;
  discover?: ApplicationHarnessRegistration["discover"];
  availability?: "available" | "unavailable";
  unavailableReason?: string;
  servedCapabilities?: readonly string[];
  qualify?: () => Promise<ApplicationHarnessQualification>;
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
    discover:
      params.discover ??
      (() => ({
        kind: "found",
        source: "path",
        description: `PATH name '${params.id}'`,
      })),
    qualify:
      params.qualify ??
      (async () => ({
        ok: false,
        failure: {
          phase: "prepare",
          category: "not-scripted",
          possibleEffects: "none",
        },
      })),
  };
}

function fixtureProcess(workspace: string, gitProbe: GitProbe): ProcessAdapter {
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
        const status = gitProbe === "fail" ? 1 : 0;
        return {
          kind: "exited",
          status,
          stdout: new TextEncoder().encode(`${workspace}\n`),
          stderr: new Uint8Array(),
        };
      }
      return git.spawnCommandSync(options);
    },
  };
}

function fixture(
  t: TestContext,
  registry: readonly ApplicationHarnessRegistration[] = [],
  gitProbe: GitProbe = "pass",
): Fixture {
  const workspace = realpathSync.native(makeTempDir("secant-lp-workspace-"));
  const process = fixtureProcess(workspace, gitProbe);
  const catalog = openCatalog(makeTempDir("secant-lp-home-"));
  t.after(() => catalog.close());
  const runGroup = openRunGroup(makeTempDir("secant-lp-store-"), workspace);
  t.after(() => runGroup.close());
  const app = createApplication({
    catalog,
    process,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    harnessRegistry: registry,
    runExecution: ({ routing, owner }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process,
      }),
  });
  return { app, catalog, runGroup, workspace };
}

function approve(f: Fixture): void {
  f.catalog.approveWorkspace(f.workspace, new Date());
}

function installCommand(
  f: Fixture,
  options?: CommandBundleOptions,
): { id: string; digest: string } {
  const cmd = writeCommandBundle(options);
  assert.ok(f.app.bundleManagement.build(cmd.folder, { noInstall: false }).ok);
  const entry = f.catalog.listEntries().find((e) => e.id === cmd.id);
  assert.ok(entry);
  return { id: cmd.id, digest: entry.digest };
}

function installAgent(f: Fixture): { id: string; digest: string } {
  const folder = makeTempDir("secant-lp-agent-");
  mkdirSync(join(folder, "prompts"));
  writeFileSync(join(folder, "prompts", "work.md"), "Do the work.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.lp-agent",
      version: "1.0.0",
      name: "LP Agent",
      description: "Agent Bundle for launch-preparation assessment.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/work.md", kind: "prompt" }],
    routing: [
      {
        id: "work",
        kind: "agent",
        session: "s",
        retry: 0,
        prompt: { asset: "prompts/work.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  assert.ok(f.app.bundleManagement.build(folder, { noInstall: false }).ok);
  const entry = f.catalog
    .listEntries()
    .find((e) => e.id === manifest.bundle.id);
  assert.ok(entry);
  return { id: entry.id, digest: entry.digest };
}

async function assess(
  f: Fixture,
  draft: LaunchRunInput,
): Promise<LaunchPreparationSnapshot> {
  const opened = f.app.projectionPort.openProjection({
    family: "launch-preparation",
    draft,
  });
  try {
    if (opened.snapshot.status !== "assessing") return opened.snapshot;
    for await (const update of opened.updates) {
      if (update.kind === "durable" && update.snapshot.status !== "assessing") {
        return update.snapshot;
      }
    }
    return opened.snapshot;
  } finally {
    opened.close();
  }
}

/** No Run, no Trust grant: assessment must leave nothing behind (AC3). */
function assertNoSideEffects(f: Fixture, digest: string): void {
  assert.deepEqual(f.runGroup.listRuns(), []);
  assert.equal(f.catalog.getTrustGrant(digest, 1), undefined);
}

function codes(snapshot: LaunchPreparationSnapshot): string[] {
  return snapshot.findings.map((finding) => finding.code);
}

function corrections(
  snapshot: LaunchPreparationSnapshot,
): (string | undefined)[] {
  return snapshot.findings.map((finding) => finding.correction);
}

// --- ready and the launch-run Offer ---------------------------------------

test("a launchable command draft is ready with no findings and offers launch-run", async (t) => {
  const f = fixture(t);
  approve(f);
  const { id, digest } = installCommand(f);
  const draft: LaunchRunInput = {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
  };
  const snapshot = await assess(f, draft);

  assert.equal(snapshot.status, "ready");
  assert.deepEqual(snapshot.findings, []);
  assert.ok(snapshot.executionSummary);
  assert.equal(snapshot.executionSummary?.digest, digest);
  const offer = snapshot.actionOffers.find(
    (candidate): candidate is LaunchRunOffer =>
      candidate.action === "launch-run",
  );
  assert.ok(offer, "a ready draft offers launch-run");
  assert.equal(offer.trustRequired, true);
  assert.deepEqual(offer.draft, draft);
  // The normalized draft carries the resolved identity and digest.
  assert.equal(snapshot.draft.bundle.digest, digest);
  assert.equal(snapshot.draft.bundle.version, "1.0.0");
  assertNoSideEffects(f, digest);
});

test("an already-trusted draft is ready and its launch-run Offer records no grant needed", async (t) => {
  const f = fixture(t);
  approve(f);
  const { id, digest } = installCommand(f);
  // Trust already granted (the assessment itself never grants).
  f.catalog.grantTrust({
    operationId: "op-grant",
    digest,
    installationGeneration: 1,
    grantedAt: new Date(),
  });

  const snapshot = await assess(f, { bundle: { id }, launchInputs: {} });
  assert.equal(snapshot.status, "ready");
  const offer = snapshot.actionOffers.find(
    (candidate): candidate is LaunchRunOffer =>
      candidate.action === "launch-run",
  );
  assert.equal(offer?.trustRequired, false);
});

// --- every finding and its correction target ------------------------------

test("an uninstalled Bundle is a not-ready bundle finding with no execution summary", async (t) => {
  const f = fixture(t);
  approve(f);
  const snapshot = await assess(f, {
    bundle: { id: "io.example.absent" },
    launchInputs: {},
  });
  assert.equal(snapshot.status, "not-ready");
  assert.deepEqual(codes(snapshot), ["bundle-not-installed"]);
  assert.deepEqual(corrections(snapshot), ["bundle"]);
  assert.equal(snapshot.executionSummary, undefined);
  assert.equal(snapshot.actionOffers.length, 0);
});

test("an unapproved Workspace is a not-ready workspace finding", async (t) => {
  const f = fixture(t);
  const { id, digest } = installCommand(f); // not approved
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
  });
  assert.equal(snapshot.status, "not-ready");
  assert.ok(codes(snapshot).includes("workspace-not-approved"));
  const finding = snapshot.findings.find(
    (candidate) => candidate.code === "workspace-not-approved",
  );
  assert.equal(finding?.correction, "workspace");
});

test("a corrupted pinned Snapshot is a single not-ready bundle finding", async (t) => {
  const f = fixture(t);
  approve(f);
  // Install shape-valid bytes that no longer compose (a Step requires nothing binds).
  const cmd = writeCommandBundle();
  const built = buildBundle(cmd.folder);
  assert.ok(built.ok);
  const entries = readArchiveEntries(built.built.bytes);
  const manifestEntry = entries.find((e) => e.path === "manifest.json");
  assert.ok(manifestEntry);
  const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  manifest.routing[0].requires = ["ghost-artifact"];
  const bytes = writeZip(
    entries.map((e) =>
      e.path === "manifest.json"
        ? { path: e.path, data: Buffer.from(JSON.stringify(manifest)) }
        : { path: e.path, data: e.data },
    ),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    f.catalog.installBundle({
      identity: { id: manifest.bundle.id, version: manifest.bundle.version },
      digest,
      bytes,
      origin: { kind: "local-file", path: "corrupt.wfb" },
      installedAt: new Date(),
    }).outcome,
    "installed",
  );

  const snapshot = await assess(f, {
    bundle: { id: manifest.bundle.id },
    launchInputs: {},
  });
  assert.equal(snapshot.status, "not-ready");
  assert.deepEqual(codes(snapshot), ["bundle-snapshot-corrupt"]);
  assert.deepEqual(corrections(snapshot), ["bundle"]);
});

test("a headless interactive-agent Bundle is a not-ready bundle finding", async (t) => {
  const f = fixture(t); // supportsInteractiveTurns defaults to false (headless)
  approve(f);
  const folder = makeTempDir("secant-lp-interactive-");
  writeFileSync(join(folder, "grill.md"), "Grill me.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.lp-interactive",
      version: "1.0.0",
      name: "LP Interactive",
      description: "Interactive Bundle refused headlessly.",
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
  assert.ok(f.app.bundleManagement.build(folder, { noInstall: false }).ok);
  const entry = f.catalog
    .listEntries()
    .find((e) => e.id === manifest.bundle.id)!;

  const snapshot = await assess(f, {
    bundle: { id: entry.id },
    launchInputs: {},
    trustDigest: entry.digest,
  });
  assert.equal(snapshot.status, "not-ready");
  const finding = snapshot.findings.find(
    (candidate) => candidate.code === "interactive-step-needs-tui",
  );
  assert.equal(finding?.correction, "bundle");
});

test("an Agent draft missing a Harness selection is a not-ready harness finding", async (t) => {
  const f = fixture(t, [
    registeredHarness({ id: "claude-code", name: "Claude Code" }),
  ]);
  approve(f);
  const { id, digest } = installAgent(f);
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
  });
  assert.equal(snapshot.status, "not-ready");
  const finding = snapshot.findings.find(
    (candidate) => candidate.code === "harness-selection-required",
  );
  assert.equal(finding?.correction, "harness");
});

test("a Command-only draft with a requested model is a not-ready model finding", async (t) => {
  const f = fixture(t);
  approve(f);
  const { id, digest } = installCommand(f);
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
    requestedModel: "opus",
  });
  assert.equal(snapshot.status, "not-ready");
  const finding = snapshot.findings.find(
    (candidate) => candidate.code === "requested-model-irrelevant",
  );
  assert.equal(finding?.correction, "model");
});

test("invalid Launch inputs are a not-ready inputs finding carrying field violations", async (t) => {
  const f = fixture(t);
  approve(f);
  const { id, digest } = installCommand(f, {
    inputs: { note: { type: "text", description: "a note" } },
  });
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
  });
  assert.equal(snapshot.status, "not-ready");
  const finding = snapshot.findings.find(
    (candidate) => candidate.code === "launch-input-invalid",
  );
  assert.equal(finding?.correction, "inputs");
  assert.equal(finding?.fieldViolations?.[0]?.field, "note");
});

test("a failed Workspace prerequisite is a not-ready workspace finding", async (t) => {
  const f = fixture(t, [], "fail");
  approve(f);
  const { id, digest } = installCommand(f, {
    prerequisites: ["git-worktree-root"],
  });
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
  });
  assert.equal(snapshot.status, "not-ready");
  const finding = snapshot.findings.find(
    (candidate) => candidate.code === "workspace-prerequisite-failed",
  );
  assert.equal(finding?.correction, "workspace");
});

test("a missing Command executable is a not-ready command finding", async (t) => {
  const f = fixture(t);
  approve(f);
  const { id, digest } = installCommand(f, {
    executable: "secant-no-such-binary-xyz",
  });
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
  });
  assert.equal(snapshot.status, "not-ready");
  const finding = snapshot.findings.find(
    (candidate) => candidate.code === "command-executable-not-found",
  );
  assert.equal(finding?.correction, "command");
});

test("a missing trust acknowledgement is a not-ready trust finding", async (t) => {
  const f = fixture(t);
  approve(f);
  const { id } = installCommand(f);
  const snapshot = await assess(f, { bundle: { id }, launchInputs: {} });
  assert.equal(snapshot.status, "not-ready");
  const finding = snapshot.findings.find(
    (candidate) => candidate.code === "bundle-trust-required",
  );
  assert.equal(finding?.correction, "trust");
});

// --- several findings in one assessment (all problems in one invocation) ---

test("a draft with several faults reports a finding per fault in launch order", async (t) => {
  const f = fixture(t);
  approve(f);
  // A required input left unprovided AND no trust acknowledgement: both surface.
  const { id } = installCommand(f, {
    inputs: { note: { type: "text", description: "a note" } },
  });
  const snapshot = await assess(f, { bundle: { id }, launchInputs: {} });
  assert.equal(snapshot.status, "not-ready");
  assert.deepEqual(codes(snapshot), [
    "launch-input-invalid",
    "bundle-trust-required",
  ]);
  assert.deepEqual(corrections(snapshot), ["inputs", "trust"]);
});

// --- requested-model qualification (the assessing status) ------------------

test("a requested model in the Harness's declared list assesses ready", async (t) => {
  let qualificationCalls = 0;
  const f = fixture(t, [
    registeredHarness({
      id: "codex",
      name: "Codex",
      qualify: async () => {
        qualificationCalls++;
        return { ok: true, profile: listProfile(["m1", "m2"]) };
      },
    }),
  ]);
  approve(f);
  const { id, digest } = installAgent(f);
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
    harness: "codex",
    requestedModel: "m1",
  });
  assert.equal(snapshot.status, "ready");
  assert.deepEqual(snapshot.findings, []);
  assert.equal(qualificationCalls, 1);
});

test("a requested model outside the declared list is a not-ready model finding after qualifying", async (t) => {
  const f = fixture(t, [
    registeredHarness({
      id: "codex",
      name: "Codex",
      qualify: async () => ({ ok: true, profile: listProfile(["m1", "m2"]) }),
    }),
  ]);
  approve(f);
  const { id, digest } = installAgent(f);
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
    harness: "codex",
    requestedModel: "m9",
  });
  assert.equal(snapshot.status, "not-ready");
  const finding = snapshot.findings.find(
    (candidate) => candidate.code === "requested-model-unavailable",
  );
  assert.equal(finding?.correction, "model");
  assert.match(finding?.remediation ?? "", /m1, m2/);
  assertNoSideEffects(f, digest);
});

test("a Harness that fails qualification while checking a model is a not-ready harness finding", async (t) => {
  const f = fixture(t, [
    registeredHarness({
      id: "codex",
      name: "Codex",
      qualify: async () => ({
        ok: false,
        failure: {
          phase: "prepare",
          category: "authentication",
          possibleEffects: "none",
          diagnostics: "login required",
        },
      }),
    }),
  ]);
  approve(f);
  const { id, digest } = installAgent(f);
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
    harness: "codex",
    requestedModel: "m1",
  });
  assert.equal(snapshot.status, "not-ready");
  const finding = snapshot.findings.find(
    (candidate) => candidate.code === "harness-qualification-unavailable",
  );
  assert.equal(finding?.correction, "harness");
});

test("an Agent draft with no requested model never qualifies the Harness", async (t) => {
  let qualificationCalls = 0;
  const f = fixture(t, [
    registeredHarness({
      id: "codex",
      name: "Codex",
      qualify: async () => {
        qualificationCalls++;
        return { ok: true, profile: listProfile(["m1"]) };
      },
    }),
  ]);
  approve(f);
  const { id, digest } = installAgent(f);
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
    harness: "codex",
  });
  assert.equal(snapshot.status, "ready");
  assert.equal(qualificationCalls, 0);
});

test("a draft already not-ready for another reason never qualifies the Harness for its model", async (t) => {
  let qualificationCalls = 0;
  const f = fixture(t, [
    registeredHarness({
      id: "codex",
      name: "Codex",
      qualify: async () => {
        qualificationCalls++;
        return { ok: true, profile: listProfile(["m1"]) };
      },
    }),
  ]);
  approve(f);
  const { id } = installAgent(f); // launched below without trust → a sync finding
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    harness: "codex",
    requestedModel: "m9", // would fail the model check, but is never reached
  });
  // Not-ready is settled synchronously from the trust finding; no Harness is spawned
  // to add a model finding to an already-doomed draft.
  assert.equal(snapshot.status, "not-ready");
  assert.equal(qualificationCalls, 0);
  assert.deepEqual(codes(snapshot), ["bundle-trust-required"]);
});

test("a Command-only draft with both a Harness and a model reports both irrelevant findings", async (t) => {
  const f = fixture(t, [registeredHarness({ id: "codex", name: "Codex" })]);
  approve(f);
  const { id, digest } = installCommand(f);
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
    harness: "codex",
    requestedModel: "opus",
  });
  assert.equal(snapshot.status, "not-ready");
  assert.deepEqual(codes(snapshot), [
    "harness-selection-irrelevant",
    "requested-model-irrelevant",
  ]);
  assert.deepEqual(corrections(snapshot), ["harness", "model"]);
});

test("a Harness that throws during model qualification is not-ready, never falsely ready", async (t) => {
  const f = fixture(t, [
    registeredHarness({
      id: "codex",
      name: "Codex",
      qualify: async () => {
        throw new Error("qualification blew up");
      },
    }),
  ]);
  approve(f);
  const { id, digest } = installAgent(f);
  const snapshot = await assess(f, {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
    harness: "codex",
    requestedModel: "m1",
  });
  assert.equal(snapshot.status, "not-ready");
  const finding = snapshot.findings.find(
    (candidate) => candidate.code === "harness-qualification-unavailable",
  );
  assert.equal(finding?.correction, "harness");
});

// --- changed draft opens a new Projection (the selector is the draft) ------

test("changing the requested model re-assesses against the new draft", async (t) => {
  const f = fixture(t, [
    registeredHarness({
      id: "codex",
      name: "Codex",
      qualify: async () => ({ ok: true, profile: listProfile(["m1", "m2"]) }),
    }),
  ]);
  approve(f);
  const { id, digest } = installAgent(f);
  const base = {
    bundle: { id },
    launchInputs: {},
    trustDigest: digest,
    harness: "codex",
  } as const;

  const bad = await assess(f, { ...base, requestedModel: "m9" });
  assert.equal(bad.status, "not-ready");
  const good = await assess(f, { ...base, requestedModel: "m2" });
  assert.equal(good.status, "ready");
});

// --- revalidation: ready assessed, then truth changes ----------------------

test("a draft assessed ready then launched after its input file is gone is refused with the inputs target, creating no Run", async (t) => {
  const f = fixture(t);
  approve(f);
  const dir = makeTempDir("secant-lp-input-");
  const file = join(dir, "in.txt");
  writeFileSync(file, "content\n");
  const { id, digest } = installCommand(f, {
    inputs: { doc: { type: "file", description: "a file" } },
  });
  const draft: LaunchRunInput = {
    bundle: { id },
    launchInputs: { doc: file },
    trustDigest: digest,
  };
  assert.equal((await assess(f, draft)).status, "ready");

  // Truth changes: the input file is gone after the ready assessment. Launch reruns
  // every authoritative check and refuses with the matching correction target.
  rmSync(file);

  const admission = f.app.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: draft,
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "launch-input-invalid");
  assert.equal(admission.problem.correction, "inputs");
  assert.deepEqual(f.runGroup.listRuns(), []);
});
