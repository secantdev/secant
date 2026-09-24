import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  HarnessProfile,
  PreparedHarness,
  TurnResult,
} from "../../../src/harness/harness.js";
import {
  executeRouting,
  type AssetResolver,
} from "../../../src/run/execution/execution.js";
import type { RunOwner } from "../../../src/run/store/store.js";
import type {
  AgentStep,
  ArtifactType,
  AssetKind,
  Platform,
} from "../../../src/workflow/workflow.js";
import { createFake, type FakeTurnScript } from "../../harness/fake-adapter.js";
import { makeTempDir } from "../../helpers/tempDir.js";
import { createFakeProcess } from "../../process/fake-adapter.js";
import { openFakeRunGroup as openRunGroup } from "../store/fake-git-process.js";

const AT = new Date("2026-09-18T08:00:00.000Z");
const HOST: Platform = process.platform === "win32" ? "windows" : "linux";
const SESSION = "shared-session";
const executionProcess = createFakeProcess({});

function profile(overrides: Partial<HarnessProfile> = {}): HarnessProfile {
  return {
    harness: "fake",
    executable: "fake-harness",
    executableVersion: "0.0.0-fake",
    platform: HOST,
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "fake resumes by id" },
    interruption: { mode: "process-only", evidence: "fake stops its process" },
    approvals: { available: true, evidence: "fake approvals" },
    clarifications: { available: false, evidence: "fake has no questions" },
    steer: { available: false, evidence: "fake has no steer" },
    modelSelection: { at: "unavailable", evidence: "fake selects no model" },
    modelObservation: {
      available: true,
      evidence: "fake observes its own model",
    },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "fake records before submission",
    },
    skillDelivery: {
      mode: "plain-path",
      evidence: "fake reads a SKILL.md path",
    },
    fileDelivery: {
      mode: "plain-path",
      evidence: "fake reads absolute paths",
    },
    ...overrides,
  };
}

interface Fixture {
  readonly owner: RunOwner;
  readonly workspace: string;
  /** The Run's canonical state as the Store records it right now. */
  readonly state: () => string;
}

function fixture(
  t: TestContext,
  launch: Readonly<Record<string, string>> = {},
): Fixture {
  const workspace = makeTempDir("secant-agent-workspace-");
  const group = openRunGroup(makeTempDir("secant-agent-home-"), workspace);
  t.after(() => group.close());
  const created = group.createRun({
    operationId: "op-1",
    bundleSnapshotDigest: "sha256:agent",
    launch,
    at: AT,
  });
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") throw new Error("unreachable");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  const state = () => {
    const read = group.readRun(created.runId);
    assert.ok(read.ok);
    return read.run.state;
  };
  return { owner, workspace, state };
}

function promptAssets(
  workspace: string,
  prompt: string,
): {
  readonly resolveAsset: AssetResolver;
  readonly promptPath: string;
  readonly skillDirectory: string;
} {
  const promptPath = join(workspace, "prompt.md");
  writeFileSync(promptPath, prompt);
  const skillDirectory = join(workspace, "skill");
  mkdirSync(skillDirectory);
  writeFileSync(join(skillDirectory, "SKILL.md"), "Use the fake skill.\n");
  const paths = new Map([
    ["prompt.md", promptPath],
    ["skill", skillDirectory],
  ]);
  return {
    resolveAsset: (assetPath) => paths.get(assetPath),
    promptPath,
    skillDirectory,
  };
}

function agentStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id: "agent",
    kind: "agent",
    prompt: { asset: "prompt.md" },
    session: SESSION,
    retry: 0,
    ...overrides,
  };
}

async function preparedHarness(
  harnessProfile: HarnessProfile,
  turns: readonly FakeTurnScript[],
): Promise<PreparedHarness> {
  const result = await createFake({ profile: harnessProfile, turns })().prepare(
    {
      workspace: "/unused",
    },
  );
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  return result.harness;
}

interface ResultCase {
  readonly result: TurnResult;
  readonly expectedAttempts: readonly (
    "succeeded" | "failed" | "cancelled" | "indeterminate"
  )[];
  readonly expectedAvailability: "open" | "detached" | "unusable";
  readonly expectedRunOutcome: "succeeded" | "failed" | "halted";
  readonly starts: number;
}

const RESULT_CASES = {
  "not-started": {
    result: {
      kind: "not-started",
      detail: {
        failure: {
          phase: "launch",
          category: "spawn-error",
          possibleEffects: "none",
          diagnostics: "the fake executable did not launch",
        },
      },
    },
    expectedAttempts: ["failed", "failed", "failed"],
    expectedAvailability: "open",
    expectedRunOutcome: "failed",
    starts: 3,
  },
  completed: {
    result: {
      kind: "completed",
      detail: {
        finalContent: "done",
        effectiveModel: { known: true, model: "fake-model" },
        session: { state: "open" },
      },
    },
    expectedAttempts: ["succeeded"],
    expectedAvailability: "open",
    expectedRunOutcome: "succeeded",
    starts: 1,
  },
  failed: {
    result: {
      kind: "failed",
      detail: {
        failure: {
          phase: "turn",
          category: "native-failure",
          possibleEffects: "possible",
          diagnostics: "the fake Turn failed",
        },
        effectiveModel: { known: false },
        session: {
          state: "detached",
          coordinate: { opaque: "failed-coordinate" },
        },
      },
    },
    expectedAttempts: ["failed"],
    expectedAvailability: "detached",
    expectedRunOutcome: "failed",
    starts: 1,
  },
  interrupted: {
    result: {
      kind: "interrupted",
      detail: {
        interruption: {
          mode: "process-only",
          evidence: "the fake process stopped",
        },
        session: {
          state: "detached",
          coordinate: { opaque: "interrupted-coordinate" },
        },
      },
    },
    expectedAttempts: ["cancelled"],
    expectedAvailability: "detached",
    expectedRunOutcome: "halted",
    starts: 1,
  },
  lost: {
    result: {
      kind: "lost",
      detail: {
        unknown: "completion",
        lastObservation: "the fake transport closed",
        session: {
          state: "unusable",
          reason: "the fake Session cannot recover",
        },
      },
    },
    expectedAttempts: ["indeterminate"],
    expectedAvailability: "unusable",
    expectedRunOutcome: "halted",
    starts: 1,
  },
} as const satisfies Record<TurnResult["kind"], ResultCase>;

for (const [kind, scenario] of Object.entries(RESULT_CASES)) {
  test(`an Agent Turn result ${kind} maps to its Attempt and Session availability`, async (t) => {
    const f = fixture(t);
    const assets = promptAssets(f.workspace, "Do the work.\n");
    const turns = Array.from({ length: scenario.starts }, () => ({
      result: scenario.result,
    }));
    const prepared = await preparedHarness(profile(), turns);
    t.after(() => prepared.close());
    let starts = 0;
    const availabilityBeforeStarts: string[] = [];
    const counted: PreparedHarness = {
      profile: prepared.profile,
      startTurn(request) {
        starts++;
        const recorded = f.owner
          .harnessSessions()
          .find((session) => session.session === SESSION);
        if (recorded !== undefined) {
          availabilityBeforeStarts.push(recorded.availability);
        }
        return prepared.startTurn(request);
      },
      close: () => prepared.close(),
    };

    const report = await executeRouting(
      [agentStep({ retry: kind === "not-started" ? 2 : 0 })],
      {
        owner: f.owner,
        platform: HOST,
        resolveAsset: assets.resolveAsset,
        now: () => AT,
        process: executionProcess,
        harness: {
          prepared: counted,
          inputTypes: {},
          assetKinds: { "prompt.md": "prompt" },
        },
      },
    );

    assert.equal(report.outcome, scenario.expectedRunOutcome);
    assert.deepEqual(
      f.owner.attemptLog().map((attempt) => attempt.outcome),
      scenario.expectedAttempts,
    );
    assert.equal(starts, scenario.starts);
    assert.equal(f.owner.turns().length, scenario.starts);
    assert.ok(
      availabilityBeforeStarts.every(
        (availability) => availability !== "unusable",
      ),
    );
    const session = f.owner
      .harnessSessions()
      .find((candidate) => candidate.session === SESSION);
    assert.equal(session?.availability, scenario.expectedAvailability);
  });
}

// An interrupted or lost Entry Turn rests the Run `halted` with no Attempt, and the
// resume walk finds the admitted Entry Turn in history: it rests `blocked` for the
// human without re-sending it, so the Entry Turn is sent exactly once (#212, A24).
for (const kind of ["interrupted", "lost"] as const) {
  test(`an Entry Turn result ${kind} rests the Run halted with no Attempt, and resume never re-sends it (#212)`, async (t) => {
    const f = fixture(t);
    const assets = promptAssets(f.workspace, "Grill the idea.\n");
    const prepared = await preparedHarness(profile(), [
      { result: RESULT_CASES[kind].result },
    ]);
    t.after(() => prepared.close());
    let starts = 0;
    const counted: PreparedHarness = {
      profile: prepared.profile,
      startTurn(request) {
        starts++;
        return prepared.startTurn(request);
      },
      close: () => prepared.close(),
    };
    const walk = () =>
      executeRouting(
        [agentStep({ kind: "interactive-agent", entryTurn: true })],
        {
          owner: f.owner,
          platform: HOST,
          resolveAsset: assets.resolveAsset,
          now: () => AT,
          process: executionProcess,
          harness: {
            prepared: counted,
            inputTypes: {},
            assetKinds: { "prompt.md": "prompt" },
          },
        },
      );

    assert.deepEqual(await walk(), { outcome: "halted" });
    assert.equal(f.state(), "halted");
    assert.deepEqual(f.owner.attemptLog(), []);
    assert.equal(starts, 1);

    assert.deepEqual(await walk(), { outcome: "blocked" });
    assert.equal(f.state(), "blocked");
    assert.deepEqual(f.owner.attemptLog(), []);
    assert.equal(starts, 1);
    assert.deepEqual(
      f.owner.turns().map((turn) => [turn.turnId, turn.origin]),
      [["0.0:agent#entry", "managed"]],
    );
  });
}

for (const delivery of ["skill", "file"] as const) {
  test(`a non-plain-path ${delivery} delivery is a typed failure before a Turn starts`, async (t) => {
    const launch: Readonly<Record<string, string>> =
      delivery === "file" ? { report: "reports/input.md" } : {};
    const f = fixture(t, launch);
    const prompt =
      delivery === "file" ? "Read {{artifact:report}}.\n" : "Use the skill.\n";
    const assets = promptAssets(f.workspace, prompt);
    const harnessProfile = profile(
      delivery === "skill"
        ? {
            skillDelivery: {
              mode: "native",
              evidence: "the fake accepts native skills only",
            },
          }
        : {
            fileDelivery: {
              mode: "native",
              evidence: "the fake accepts native files only",
            },
          },
    );
    const prepared = await preparedHarness(harnessProfile, []);
    t.after(() => prepared.close());
    let starts = 0;
    const counted: PreparedHarness = {
      profile: prepared.profile,
      startTurn(request) {
        starts++;
        return prepared.startTurn(request);
      },
      close: () => prepared.close(),
    };
    const inputTypes: Readonly<Record<string, ArtifactType>> =
      delivery === "file" ? { report: "file" } : {};
    const assetKinds: Readonly<Record<string, AssetKind>> = {
      "prompt.md": "prompt",
      skill: "skill",
    };

    const report = await executeRouting(
      [
        agentStep({
          uses: delivery === "skill" ? [{ asset: "skill" }] : [],
        }),
      ],
      {
        owner: f.owner,
        platform: HOST,
        resolveAsset: assets.resolveAsset,
        now: () => AT,
        process: executionProcess,
        harness: { prepared: counted, inputTypes, assetKinds },
      },
    );

    assert.deepEqual(report, { outcome: "failed" });
    assert.deepEqual(
      f.owner.attemptLog().map((attempt) => attempt.outcome),
      ["failed"],
    );
    assert.equal(starts, 0);
    assert.deepEqual(f.owner.turns(), []);
  });
}

test("plain-path delivery keeps the rendered prompt byte-identical", async (t) => {
  const f = fixture(t, { report: "reports/input.md" });
  const assets = promptAssets(
    f.workspace,
    "Review {{artifact:report}} before acting.\n",
  );
  const completed = RESULT_CASES.completed.result;
  const prepared = await preparedHarness(profile(), [{ result: completed }]);
  t.after(() => prepared.close());

  await executeRouting(
    [
      agentStep({
        uses: [{ asset: "skill" }],
      }),
    ],
    {
      owner: f.owner,
      platform: HOST,
      resolveAsset: assets.resolveAsset,
      now: () => AT,
      process: executionProcess,
      harness: {
        prepared,
        inputTypes: { report: "file" },
        assetKinds: { "prompt.md": "prompt", skill: "skill" },
      },
    },
  );

  assert.equal(
    f.owner.transcript()[0]?.content,
    `Review ${join(f.workspace, "reports", "input.md")} before acting.\n\n\nRead the skill instructions at ${join(assets.skillDirectory, "SKILL.md")} before you begin.`,
  );
});

// --- Required text output receipts (#215) ----------------------------------

const RECEIPT_LINE =
  /Write the required output "([^"]+)" as UTF-8 text to (.+) before you finish;/g;

/** The receipt paths execution appended to a rendered prompt, by output name. */
function receiptPaths(input: string): ReadonlyMap<string, string> {
  return new Map(
    [...input.matchAll(RECEIPT_LINE)].map((match) => [match[1]!, match[2]!]),
  );
}

/** Wrap a prepared fake so each Turn plays the agent: `write` decides, per Turn,
 *  what to leave at the receipt paths the prompt named (nothing when undefined). */
function receiptWriting(
  prepared: PreparedHarness,
  write: (paths: ReadonlyMap<string, string>, turn: number) => void | undefined,
): { harness: PreparedHarness; inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    harness: {
      profile: prepared.profile,
      startTurn(request) {
        inputs.push(request.input.text);
        write(receiptPaths(request.input.text), inputs.length - 1);
        return prepared.startTurn(request);
      },
      close: () => prepared.close(),
    },
  };
}

const COMPLETED: TurnResult = RESULT_CASES.completed.result;

function producingStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return agentStep({
    produces: [{ name: "spec-ref", type: "text" }],
    ...overrides,
  });
}

function executeWith(
  f: Fixture,
  step: AgentStep,
  harness: PreparedHarness,
): ReturnType<typeof executeRouting> {
  const assets = promptAssets(f.workspace, "Publish the spec.\n");
  return executeRouting([step], {
    owner: f.owner,
    platform: HOST,
    resolveAsset: assets.resolveAsset,
    now: () => AT,
    process: executionProcess,
    harness: {
      prepared: harness,
      inputTypes: {},
      assetKinds: { "prompt.md": "prompt" },
    },
  });
}

function boundText(owner: RunOwner, name: string): string | undefined {
  const versionId = owner.currentVersion(name);
  if (versionId === undefined) return undefined;
  const bytes = owner.readArtifact(versionId, name);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

/** Bind an earlier version of `spec-ref`, as a previous Step would have. */
function bindEarlier(owner: RunOwner, text: string): string {
  const published = owner.publishAttempt({
    attemptId: "earlier",
    outcome: "succeeded",
    required: [{ name: "spec-ref", type: "text" }],
    outputs: [
      {
        name: "spec-ref",
        type: "text",
        content: new TextEncoder().encode(text),
      },
    ],
    at: AT,
  });
  assert.ok(published.ok && published.versionId);
  return published.versionId;
}

test("a completed Turn's validated receipt is published as the declared text output", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(profile(), [{ result: COMPLETED }]);
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, (paths) => {
    const path = paths.get("spec-ref");
    assert.ok(path, "the prompt names the receipt path");
    writeFileSync(path, "  https://github.com/example/repo/issues/12\n");
  });

  const report = await executeWith(f, producingStep(), agent.harness);

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.deepEqual(
    f.owner.attemptLog().map((attempt) => attempt.outcome),
    ["succeeded"],
  );
  // The reference is bound verbatim, trimmed of the surrounding whitespace a file
  // write leaves, so a later prompt slot substitutes it cleanly.
  assert.equal(
    boundText(f.owner, "spec-ref"),
    "https://github.com/example/repo/issues/12",
  );
  // The receipt path is an absolute, Run-owned location outside the Workspace.
  const path = receiptPaths(agent.inputs[0]!).get("spec-ref")!;
  assert.ok(isAbsolute(path));
  assert.ok(relative(f.workspace, path).startsWith(".."));
  // The instruction is appended after the authored prompt; the prompt stays first.
  assert.ok(agent.inputs[0]!.startsWith("Publish the spec.\n"));
});

test("a completed Turn with no receipt fails the Step and leaves the earlier binding intact", async (t) => {
  const f = fixture(t);
  const earlier = bindEarlier(f.owner, "LOCAL:spec.md");
  const prepared = await preparedHarness(profile(), [{ result: COMPLETED }]);
  t.after(() => prepared.close());
  // The agent's prose may claim publication; only the receipt file counts.
  const agent = receiptWriting(prepared, () => undefined);

  const report = await executeWith(f, producingStep(), agent.harness);

  assert.deepEqual(report, { outcome: "failed" });
  assert.deepEqual(
    f.owner.attemptLog().map((attempt) => attempt.outcome),
    ["succeeded", "failed"],
  );
  assert.equal(f.owner.currentVersion("spec-ref"), earlier);
  assert.equal(boundText(f.owner, "spec-ref"), "LOCAL:spec.md");
  // The Turn itself completed: its durable record says so, distinct from the Step.
  assert.equal(f.owner.turns()[0]?.resultKind, "completed");
});

const INVALID_RECEIPTS: Readonly<Record<string, (path: string) => void>> = {
  "an empty receipt": (path) => writeFileSync(path, ""),
  "a whitespace-only receipt": (path) => writeFileSync(path, " \n\t\n"),
  "a receipt that is not UTF-8": (path) =>
    writeFileSync(path, Uint8Array.from([0x68, 0xff, 0xfe, 0x69])),
  "an oversized receipt": (path) =>
    writeFileSync(path, "x".repeat(64 * 1024 + 1)),
  "a directory in place of the receipt file": (path) => mkdirSync(path),
};

for (const [title, write] of Object.entries(INVALID_RECEIPTS)) {
  test(`${title} fails the Step and moves no binding`, async (t) => {
    const f = fixture(t);
    const earlier = bindEarlier(f.owner, "LOCAL:spec.md");
    const prepared = await preparedHarness(profile(), [{ result: COMPLETED }]);
    t.after(() => prepared.close());
    const agent = receiptWriting(prepared, (paths) =>
      write(paths.get("spec-ref")!),
    );

    const report = await executeWith(f, producingStep(), agent.harness);

    assert.deepEqual(report, { outcome: "failed" });
    assert.equal(f.owner.currentVersion("spec-ref"), earlier);
  });
}

test("a receipt of exactly the size limit is accepted", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(profile(), [{ result: COMPLETED }]);
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, (paths) =>
    writeFileSync(paths.get("spec-ref")!, "x".repeat(64 * 1024)),
  );

  const report = await executeWith(f, producingStep(), agent.harness);

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.equal(boundText(f.owner, "spec-ref")?.length, 64 * 1024);
});

test("a retried Attempt names a fresh receipt path, so an earlier receipt never satisfies it", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(profile(), [
    { result: COMPLETED },
    { result: COMPLETED },
  ]);
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, (paths, turn) => {
    // The first Turn writes nothing; the retry writes its own receipt.
    if (turn === 1) writeFileSync(paths.get("spec-ref")!, "gh#12");
  });

  const report = await executeWith(
    f,
    producingStep({ retry: 1 }),
    agent.harness,
  );

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.deepEqual(
    f.owner.attemptLog().map((attempt) => attempt.outcome),
    ["failed", "succeeded"],
  );
  const [first, second] = agent.inputs.map((input) =>
    receiptPaths(input).get("spec-ref")!,
  );
  assert.notEqual(first, second);
  assert.equal(boundText(f.owner, "spec-ref"), "gh#12");
});

test("a receipt left by a Turn that did not complete is never published", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(profile(), [
    { result: RESULT_CASES.failed.result },
  ]);
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, (paths) =>
    writeFileSync(paths.get("spec-ref")!, "gh#12"),
  );

  const report = await executeWith(f, producingStep(), agent.harness);

  assert.deepEqual(report, { outcome: "failed" });
  assert.equal(f.owner.currentVersion("spec-ref"), undefined);
});

test("an Agent Step with no declared output gets no receipt instruction", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(profile(), [{ result: COMPLETED }]);
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, () => undefined);

  const report = await executeWith(f, agentStep(), agent.harness);

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.equal(agent.inputs[0], "Publish the spec.\n");
});

test("a producing Step whose working area is unusable fails typed before any Turn (#220)", async (t) => {
  const f = fixture(t);
  const prepared = await preparedHarness(profile(), [{ result: COMPLETED }]);
  t.after(() => prepared.close());
  const agent = receiptWriting(prepared, () => undefined);
  // Receipts live in the working area; a squatted area is typed, never a throw.
  const owner: RunOwner = {
    ...f.owner,
    workingArea: () => ({
      ok: false,
      problem: {
        kind: "working-area-unavailable",
        path: "/squatted",
        cause: undefined,
      },
    }),
  };

  const report = await executeWith(
    { ...f, owner },
    producingStep(),
    agent.harness,
  );

  assert.deepEqual(report, { outcome: "failed" });
  assert.deepEqual(agent.inputs, []);
});
