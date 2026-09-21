import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  return { owner, workspace };
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
