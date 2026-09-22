import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import type { ApplicationHarnessQualification } from "../../src/application/application.js";
import { createApplication } from "../helpers/application.js";
import type {
  HarnessFocusSnapshot,
  ProjectionPort,
} from "../../src/application/projection-port.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import type { HarnessProfile } from "../../src/harness/harness.js";
import { makeTempDir } from "../helpers/tempDir.js";

interface Fixture {
  readonly port: ProjectionPort;
  readonly discoveryCalls: () => number;
  readonly qualificationCalls: () => number;
}

const PROFILE: HarnessProfile = {
  harness: "Codex",
  executable: "PATH name 'codex' -> /tools/codex",
  executableVersion: "1.2.3",
  platform: "linux",
  adapterRevision: "catalog-test-v1",
  configurationPosture: "Uses the user's existing Codex configuration.",
  recovery: {
    mode: "load-with-replay",
    evidence: "Reloads retained history before live activity.",
  },
  interruption: {
    mode: "process-only",
    evidence: "Stops the process and detaches the Session.",
  },
  approvals: { available: true, evidence: "Native approval requests." },
  clarifications: {
    available: false,
    evidence: "No structured question request is exposed.",
  },
  steer: {
    available: false,
    evidence: "Same-Turn guidance is not exposed.",
  },
  modelSelection: {
    at: "launch-and-per-turn",
    declaration: { kind: "list", models: ["gpt-5", "gpt-5-mini"] },
    evidence: "Observed from model/list.",
  },
  modelObservation: {
    available: true,
    evidence: "Turn events identify the effective model.",
  },
  recoveryCoordinate: {
    timing: "before-submission",
    evidence: "Thread id is recorded before content.",
  },
  skillDelivery: { mode: "plain-path", evidence: "Read SKILL.md by path." },
  fileDelivery: { mode: "plain-path", evidence: "Read files by path." },
};

async function fixture(t: TestContext): Promise<Fixture> {
  const catalog = await openCatalog(
    makeTempDir("secant-harness-catalog-home-"),
  );
  t.after(() => catalog.close());
  const workspace = realpathSync.native(
    makeTempDir("secant-harness-catalog-workspace-"),
  );
  let discoveryCalls = 0;
  let qualificationCalls = 0;
  const harnessRegistry = [
    {
      choice: {
        id: "claude-code" as const,
        name: "Claude Code",
        availability: "available" as const,
      },
      servedCapabilities: ["agent-turn", "interactive-turns"],
      discover: () => {
        discoveryCalls++;
        return {
          kind: "found" as const,
          source: "path" as const,
          description: "PATH name 'claude'",
        };
      },
      qualify: async () => {
        qualificationCalls++;
        throw new Error("list must not qualify a Harness");
      },
    },
    {
      choice: {
        id: "codex" as const,
        name: "Codex",
        availability: "available" as const,
      },
      servedCapabilities: ["agent-turn", "interactive-turns"],
      discover: () => {
        discoveryCalls++;
        return {
          kind: "not-found" as const,
          searched: ["PATH name 'codex': \"codex\""],
          executableEnvironmentVariable: "SECANT_CODEX",
        };
      },
      qualify: async () => {
        qualificationCalls++;
        throw new Error("list must not qualify a Harness");
      },
    },
  ];
  const application = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    now: () => new Date("2026-09-22T00:00:00.000Z"),
    harnessRegistry,
  });
  t.after(() => application.shutdown());
  return {
    port: application.projectionPort,
    discoveryCalls: () => discoveryCalls,
    qualificationCalls: () => qualificationCalls,
  };
}

test("harness catalog list discovers every registration without qualification or Offers", async (t) => {
  const { port, discoveryCalls, qualificationCalls } = await fixture(t);
  const opened = port.openProjection({ family: "harness-catalog" });
  t.after(() => opened.close());

  assert.deepEqual(opened.snapshot, {
    family: "harness-catalog",
    view: "list",
    harnesses: [
      {
        id: "claude-code",
        name: "Claude Code",
        discovery: {
          state: "found",
          source: "path",
          description: "PATH name 'claude'",
        },
        qualification: { state: "not-checked" },
      },
      {
        id: "codex",
        name: "Codex",
        discovery: {
          state: "not-found",
          searched: ["PATH name 'codex': \"codex\""],
          executableEnvironmentVariable: "SECANT_CODEX",
        },
        qualification: { state: "not-checked" },
      },
    ],
  });
  assert.equal("actionOffers" in opened.snapshot, false);
  assert.equal(discoveryCalls(), 2);
  assert.equal(qualificationCalls(), 0);
});

async function portWithRegistration(
  t: TestContext,
  qualify: () => Promise<ApplicationHarnessQualification>,
): Promise<ProjectionPort> {
  const catalog = await openCatalog(makeTempDir("secant-harness-focus-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(
    makeTempDir("secant-harness-focus-workspace-"),
  );
  const application = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    now: () => new Date("2026-09-22T00:00:00.000Z"),
    harnessRegistry: [
      {
        choice: { id: "codex", name: "Codex", availability: "available" },
        servedCapabilities: ["agent-turn", "interactive-turns"],
        discover: () => ({
          kind: "found",
          source: "path",
          description: "PATH name 'codex'",
        }),
        qualify,
      },
    ],
  });
  t.after(() => application.shutdown());
  return application.projectionPort;
}

test("harness focus qualifies once, maps normalized capabilities, and reuses the process cache", async (t) => {
  let qualificationCalls = 0;
  const port = await portWithRegistration(t, async () => {
    qualificationCalls++;
    return { ok: true, profile: PROFILE };
  });

  const watchingList = port.openProjection({ family: "harness-catalog" });
  t.after(() => watchingList.close());
  const listUpdates = watchingList.updates[Symbol.asyncIterator]();

  const opened = port.openProjection({
    family: "harness-catalog",
    focus: { id: "codex" },
  });
  t.after(() => opened.close());
  assert.equal(qualificationCalls, 1);
  assert.equal(opened.snapshot.result.found, true);
  if (!opened.snapshot.result.found) throw new Error("unreachable");
  assert.equal(
    opened.snapshot.result.harness.qualification.state,
    "not-checked",
  );
  assert.equal("actionOffers" in opened.snapshot, false);

  const update = await opened.updates[Symbol.asyncIterator]().next();
  assert.equal(update.done, false);
  assert.ok(update.value && update.value.kind === "durable");
  if (update.value?.kind !== "durable") throw new Error("unreachable");
  const qualified = update.value.snapshot as HarnessFocusSnapshot;
  assert.deepEqual(qualified.result, {
    found: true,
    harness: {
      id: "codex",
      name: "Codex",
      discovery: {
        state: "found",
        source: "path",
        description: "PATH name 'codex'",
      },
      qualification: {
        state: "qualified-with-limits",
        observation: {
          executable: "PATH name 'codex' -> /tools/codex",
          executableVersion: "1.2.3",
          platform: "linux",
          checkedAt: "2026-09-22T00:00:00.000Z",
        },
      },
      supportedModels: { kind: "list", models: ["gpt-5", "gpt-5-mini"] },
      capabilities: [
        {
          capability: "session-recovery",
          name: "Session recovery",
          description: "Resume a Harness Session after process loss.",
          state: "available-with-limits",
          limits: "Reloads retained history before live activity.",
        },
        {
          capability: "same-turn-steering",
          name: "Same-Turn steering",
          description: "Send guidance while the current Turn is still working.",
          state: "unavailable",
        },
        {
          capability: "turn-interruption",
          name: "Turn interruption",
          description: "Stop the current Turn and its native work.",
          state: "available-with-limits",
          limits: "Stops the process and detaches the Session.",
        },
        {
          capability: "tool-approvals",
          name: "Tool approvals",
          description: "Review tool actions raised by the Harness.",
          state: "available",
        },
        {
          capability: "structured-questions",
          name: "Structured questions",
          description: "Answer structured questions raised by the Harness.",
          state: "unavailable",
        },
        {
          capability: "effective-model",
          name: "Effective model",
          description: "Observe the model that actually served a Turn.",
          state: "available",
        },
      ],
      configurationPosture: "Uses the user's existing Codex configuration.",
    },
  });

  const listUpdate = await listUpdates.next();
  assert.equal(listUpdate.done, false);
  assert.ok(listUpdate.value && listUpdate.value.kind === "durable");
  if (listUpdate.value?.kind !== "durable") throw new Error("unreachable");
  assert.deepEqual(listUpdate.value.snapshot.harnesses[0]?.qualification, {
    state: "qualified-with-limits",
    observation: {
      executable: "PATH name 'codex' -> /tools/codex",
      executableVersion: "1.2.3",
      platform: "linux",
      checkedAt: "2026-09-22T00:00:00.000Z",
    },
  });

  const repeated = port.openProjection({
    family: "harness-catalog",
    focus: { id: "codex" },
  });
  t.after(() => repeated.close());
  assert.equal(qualificationCalls, 1);
  assert.deepEqual(repeated.snapshot, qualified);

  const list = port.openProjection({ family: "harness-catalog" });
  t.after(() => list.close());
  assert.deepEqual(list.snapshot.harnesses[0]?.qualification, {
    state: "qualified-with-limits",
    observation: {
      executable: "PATH name 'codex' -> /tools/codex",
      executableVersion: "1.2.3",
      platform: "linux",
      checkedAt: "2026-09-22T00:00:00.000Z",
    },
  });
  const serialized = JSON.stringify(qualified);
  assert.doesNotMatch(
    serialized,
    /adapterRevision|recoveryCoordinate|skillDelivery|fileDelivery|evidence/,
  );
});

test("concurrent Harness focus opens share one pending qualification", async (t) => {
  let qualificationCalls = 0;
  let release:
    ((value: { ok: true; profile: HarnessProfile }) => void) | undefined;
  const qualification = new Promise<{ ok: true; profile: HarnessProfile }>(
    (resolve) => {
      release = resolve;
    },
  );
  const port = await portWithRegistration(t, () => {
    qualificationCalls++;
    return qualification;
  });

  const first = port.openProjection({
    family: "harness-catalog",
    focus: { id: "codex" },
  });
  const second = port.openProjection({
    family: "harness-catalog",
    focus: { id: "codex" },
  });
  t.after(() => first.close());
  t.after(() => second.close());
  assert.equal(qualificationCalls, 1);

  release?.({ ok: true, profile: PROFILE });
  const [firstUpdate, secondUpdate] = await Promise.all([
    first.updates[Symbol.asyncIterator]().next(),
    second.updates[Symbol.asyncIterator]().next(),
  ]);
  assert.equal(firstUpdate.done, false);
  assert.equal(secondUpdate.done, false);
});

test("authentication failure stays inspectable with remediation and a diagnostic reference", async (t) => {
  const port = await portWithRegistration(t, async () => ({
    ok: false,
    failure: {
      phase: "prepare",
      category: "authentication",
      possibleEffects: "none",
      diagnostics: "Codex account/read reported that login is required.",
    },
  }));
  const opened = port.openProjection({
    family: "harness-catalog",
    focus: { id: "codex" },
  });
  t.after(() => opened.close());
  const update = await opened.updates[Symbol.asyncIterator]().next();
  assert.ok(update.value && update.value.kind === "durable");
  if (update.value?.kind !== "durable") throw new Error("unreachable");
  const snapshot = update.value.snapshot as HarnessFocusSnapshot;
  assert.equal(snapshot.result.found, true);
  if (!snapshot.result.found) throw new Error("unreachable");
  assert.equal(snapshot.result.harness.qualification.state, "not-ready");
  assert.match(
    snapshot.result.harness.authenticationInstructions ?? "",
    /Codex/,
  );
  assert.equal(
    snapshot.result.harness.unavailable?.code,
    "harness-qualification-unavailable",
  );
  assert.match(
    snapshot.result.harness.unavailable?.remediation ?? "",
    /log in/i,
  );
  const diagnosticReference = snapshot.result.harness.diagnosticReference;
  assert.ok(diagnosticReference);
  assert.equal(diagnosticReference.type, "harness-diagnostic");
  assert.equal(diagnosticReference.harnessId, "codex");
  assert.match(diagnosticReference.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(port.readResource(diagnosticReference), {
    found: true,
    type: "diagnostic",
    content: "Codex account/read reported that login is required.",
  });
  assert.equal(
    port.readResource({
      ...diagnosticReference,
      checkedAt: "2026-09-21T00:00:00.000Z",
    }).found,
    false,
  );
  assert.deepEqual(
    port.readResource({
      type: "harness-diagnostic",
      harnessId: "claude-code",
      checkedAt: diagnosticReference.checkedAt,
    }),
    {
      found: false,
      problem: {
        code: "harness-diagnostic-missing",
        explanation:
          "The held qualification diagnostic for Harness 'claude-code' is no longer available.",
        remediation:
          "Inspect the Harness again in the current Secant process to obtain its latest diagnostic reference.",
        possibleEffects: "none",
        details: {
          harnessId: "claude-code",
          checkedAt: "2026-09-22T00:00:00.000Z",
        },
      },
    },
  );
  assert.equal("cause" in (snapshot.result.harness.unavailable ?? {}), false);
});

test("a rejected registration qualification becomes cached not-ready evidence", async (t) => {
  let qualificationCalls = 0;
  const port = await portWithRegistration(t, async () => {
    qualificationCalls++;
    throw new Error("registration rejected qualification");
  });
  const opened = port.openProjection({
    family: "harness-catalog",
    focus: { id: "codex" },
  });
  t.after(() => opened.close());
  const update = await opened.updates[Symbol.asyncIterator]().next();
  assert.ok(update.value && update.value.kind === "durable");
  if (update.value?.kind !== "durable") throw new Error("unreachable");
  assert.equal(update.value.snapshot.result.found, true);
  if (!update.value.snapshot.result.found) throw new Error("unreachable");
  const harness = update.value.snapshot.result.harness;
  assert.equal(harness.qualification.state, "not-ready");
  assert.equal(
    harness.unavailable?.details?.category,
    "qualification-exception",
  );
  assert.equal("cause" in (harness.unavailable ?? {}), false);
  assert.ok(harness.diagnosticReference);
  assert.deepEqual(port.readResource(harness.diagnosticReference), {
    found: true,
    type: "diagnostic",
    content: "registration rejected qualification",
  });

  const repeated = port.openProjection({
    family: "harness-catalog",
    focus: { id: "codex" },
  });
  t.after(() => repeated.close());
  assert.equal(qualificationCalls, 1);
  assert.equal(repeated.snapshot.result.found, true);
  if (repeated.snapshot.result.found) {
    assert.equal(
      repeated.snapshot.result.harness.qualification.state,
      "not-ready",
    );
  }
});

test("unknown Harness focus is a Problem and performs no qualification", async (t) => {
  let qualificationCalls = 0;
  const port = await portWithRegistration(t, async () => {
    qualificationCalls++;
    return { ok: true, profile: PROFILE };
  });
  const opened = port.openProjection({
    family: "harness-catalog",
    focus: { id: "gemini" },
  });
  t.after(() => opened.close());
  assert.deepEqual(opened.snapshot.result, {
    found: false,
    problem: {
      code: "harness-not-found",
      explanation: "Harness 'gemini' is not registered in this Secant build.",
      remediation: "Run `secant harness list` to see the registered Harnesses.",
      possibleEffects: "none",
      details: { harnessId: "gemini" },
    },
  });
  assert.equal(qualificationCalls, 0);
});
