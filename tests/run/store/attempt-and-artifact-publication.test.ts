import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";
import type { ProducedArtifact } from "../../../src/workflow/workflow.js";
import {
  openRunGroup,
  type PublishAttemptResult,
  type RunGroup,
} from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";

const WORKSPACE = "/work/example-project";
const AT = new Date("2026-09-12T12:00:00.000Z");
const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array | undefined) =>
  bytes && new TextDecoder().decode(bytes);
const candidate = (name: string, text: string) =>
  ({ name, type: "text", content: enc(text) }) as const;
const need = (...names: string[]): ProducedArtifact[] =>
  names.map((name) => ({ name, type: "text" }));

/** The private publication-ref directory of a Run's artifacts.git. */
function publicationRefs(home: string, runId: string): string {
  return join(
    groupDirOf(home),
    runId,
    "artifacts.git",
    "refs",
    "secant",
    "publications",
  );
}

function create(
  group: RunGroup,
  operationId: string,
  overrides: {
    digest?: string;
    launch?: unknown;
    selectedHarness?: "claude-code" | "codex";
  } = {},
) {
  return group.createRun({
    operationId,
    bundleSnapshotDigest: overrides.digest ?? "sha256:deadbeef",
    launch: overrides.launch ?? { goal: "ship it" },
    ...(overrides.selectedHarness !== undefined
      ? { selectedHarness: overrides.selectedHarness }
      : {}),
    at: AT,
  });
}

/** The group directory Secant home resolves for the test Workspace. */
function groupDirOf(home: string): string {
  const runs = join(home, "runs");
  return join(runs, readdirSync(runs)[0]!);
}

test("a succeeded Attempt publishes its whole output set as one version", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const first = owner.publishAttempt({
    attemptId: "a1",
    outcome: "succeeded",
    required: need("verdict", "text"),
    outputs: [candidate("verdict", "pass"), candidate("text", "hello")],
    at: AT,
  });
  assert.ok(first.ok && first.versionId);
  assert.equal(owner.currentVersion("verdict"), first.versionId);
  assert.equal(owner.currentVersion("text"), first.versionId);
  // Exactly one commit backs the publication.
  assert.equal(readdirSync(publicationRefs(home, created.runId)).length, 1);

  // A second publication moves only `text`'s binding; the earlier version stays
  // readable by its own id, and `verdict` still points at the first commit.
  const second = owner.publishAttempt({
    attemptId: "a2",
    outcome: "succeeded",
    required: need("text"),
    outputs: [candidate("text", "world")],
    at: AT,
  });
  assert.ok(second.ok && second.versionId);
  assert.notEqual(second.versionId, first.versionId);
  assert.equal(owner.currentVersion("text"), second.versionId);
  assert.equal(owner.currentVersion("verdict"), first.versionId);
  assert.equal(dec(owner.readArtifact(first.versionId, "text")), "hello");
  assert.equal(dec(owner.readArtifact(second.versionId, "text")), "world");
});

test("a failure between the commit and the transaction moves no binding and leaves the Attempt unsettled", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const first = owner.publishAttempt({
    attemptId: "a1",
    outcome: "succeeded",
    required: need("text"),
    outputs: [candidate("text", "keep")],
    at: AT,
  });
  assert.ok(first.ok && first.versionId);

  // Inject a fault the publication transaction hits after the commit is staged:
  // aborting the binding move must roll the whole transaction back.
  const runDbPath = join(groupDirOf(home), created.runId, "run.db");
  const raw = new Database(runDbPath);
  raw.exec(
    "CREATE TRIGGER boom BEFORE UPDATE ON artifact_binding " +
      "BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  raw.close();

  assert.throws(() =>
    owner.publishAttempt({
      attemptId: "a2",
      outcome: "succeeded",
      required: need("text"),
      outputs: [candidate("text", "changed")],
      at: AT,
    }),
  );
  // No partial state: the binding never moved and the Attempt never settled.
  assert.equal(owner.currentVersion("text"), first.versionId);
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.attemptId),
    ["a1"],
  );

  // Recovery: drop the fault and repeat the publication — it now succeeds.
  const raw2 = new Database(runDbPath);
  raw2.exec("DROP TRIGGER boom");
  raw2.close();
  const retry = owner.publishAttempt({
    attemptId: "a2",
    outcome: "succeeded",
    required: need("text"),
    outputs: [candidate("text", "changed")],
    at: AT,
  });
  assert.ok(retry.ok && retry.versionId);
  assert.equal(owner.currentVersion("text"), retry.versionId);
  assert.equal(dec(owner.readArtifact(retry.versionId, "text")), "changed");
});

test("failed, cancelled, and indeterminate Attempts keep the current bindings and log the outcome", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const pub = owner.publishAttempt({
    attemptId: "a1",
    outcome: "succeeded",
    required: need("text"),
    outputs: [candidate("text", "stable")],
    at: AT,
  });
  assert.ok(pub.ok && pub.versionId);

  for (const outcome of ["failed", "cancelled", "indeterminate"] as const) {
    const result: PublishAttemptResult = owner.publishAttempt({
      attemptId: `x-${outcome}`,
      outcome,
      required: [],
      outputs: [],
      at: AT,
    });
    assert.deepEqual(result, { ok: true });
  }
  // The previous binding is still current.
  assert.equal(owner.currentVersion("text"), pub.versionId);
  // Every outcome landed in the append-only log, in order.
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["succeeded", "failed", "cancelled", "indeterminate"],
  );
});

test("a missing required output is refused with a Problem and nothing is published", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const result = owner.publishAttempt({
    attemptId: "a1",
    outcome: "succeeded",
    required: need("verdict", "text"),
    outputs: [candidate("text", "only text")],
    at: AT,
  });
  assert.ok(!result.ok && "problem" in result);
  assert.deepEqual(result.problem, { kind: "missing-output", name: "verdict" });
  // Nothing committed and nothing settled.
  assert.equal(owner.currentVersion("text"), undefined);
  assert.deepEqual(owner.attemptLog(), []);
});

test("publishing the same Attempt id twice yields one version", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const request = {
    attemptId: "a1",
    outcome: "succeeded" as const,
    required: need("text"),
    outputs: [candidate("text", "once")],
    at: AT,
  };
  const one = owner.publishAttempt(request);
  const two = owner.publishAttempt(request);
  assert.ok(one.ok && two.ok);
  assert.equal(two.versionId, one.versionId);
  assert.equal(readdirSync(publicationRefs(home, created.runId)).length, 1);
});

test("a fenced owner cannot publish", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");

  const stale = group.acquireRun(created.runId);
  assert.ok(stale);
  t.after(() => stale.close());
  const fresh = group.acquireRun(created.runId);
  assert.ok(fresh);
  t.after(() => fresh.close());

  const request = {
    attemptId: "a1",
    outcome: "succeeded" as const,
    required: need("text"),
    outputs: [candidate("text", "x")],
    at: AT,
  };
  assert.deepEqual(stale.publishAttempt(request), {
    ok: false,
    reason: "fenced",
  });
  const ok = fresh.publishAttempt(request);
  assert.ok(ok.ok && ok.versionId);
});

test("a gate answer binds a durable, readable Artifact without logging an Attempt (#85)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId)!;
  t.after(() => owner.close());

  const result = owner.recordGateAnswer({
    operationId: "answer-1",
    gateAttemptId: "attempt-xyz",
    answer: "continue",
    iterationsAtGrant: 3,
    artifactName: "human-gate-answer",
    at: AT,
  });
  assert.ok(result.ok && !result.replayed);

  // Bound and readable like any output, but the attempt log is untouched.
  const version = owner.currentVersion("human-gate-answer");
  assert.ok(version);
  assert.equal(
    dec(owner.readArtifact(version!, "human-gate-answer")),
    "continue",
  );
  assert.equal(owner.attemptLog().length, 0);
  const answers = owner.gateAnswers();
  assert.equal(answers.length, 1);
  assert.deepEqual(
    {
      operationId: answers[0]!.operationId,
      gateAttemptId: answers[0]!.gateAttemptId,
      answer: answers[0]!.answer,
      iterationsAtGrant: answers[0]!.iterationsAtGrant,
    },
    {
      operationId: "answer-1",
      gateAttemptId: "attempt-xyz",
      answer: "continue",
      iterationsAtGrant: 3,
    },
  );
});

test("recording a gate answer is idempotent per operation id (#85)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId)!;
  t.after(() => owner.close());

  const request = {
    operationId: "answer-1",
    gateAttemptId: "attempt-xyz",
    answer: "continue" as const,
    iterationsAtGrant: 3,
    artifactName: "human-gate-answer",
    at: AT,
  };
  const first = owner.recordGateAnswer(request);
  const replay = owner.recordGateAnswer(request);
  assert.ok(first.ok && replay.ok);
  assert.equal(replay.replayed, true);
  assert.equal(first.versionId, replay.versionId);
  assert.equal(owner.gateAnswers().length, 1);
});

test("a stop answer rests the Run failed in the same transaction (#85)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId)!;
  t.after(() => owner.close());

  const result = owner.recordGateAnswer({
    operationId: "answer-1",
    gateAttemptId: "attempt-xyz",
    answer: "stop",
    iterationsAtGrant: 3,
    artifactName: "human-gate-answer",
    at: AT,
    advanceState: "failed",
  });
  assert.ok(result.ok);
  const read = group.readRun(created.runId);
  assert.ok(read.ok && read.run.state === "failed");
});

test("a fenced owner cannot record a gate answer (#85)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const stale = group.acquireRun(created.runId)!;
  const fresh = group.acquireRun(created.runId)!; // bumps the epoch, fencing `stale`
  t.after(() => fresh.close());

  assert.deepEqual(
    stale.recordGateAnswer({
      operationId: "answer-1",
      gateAttemptId: "attempt-xyz",
      answer: "continue",
      iterationsAtGrant: 0,
      artifactName: "human-gate-answer",
      at: AT,
    }),
    { ok: false, reason: "fenced" },
  );
  assert.equal(fresh.gateAnswers().length, 0);
});

// --- Read-ingress validation of the two enum columns (A11) ------------------

test("a garbage attempt_log.outcome is rejected at the read, never trusted", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  owner.publishAttempt({
    attemptId: "a1",
    outcome: "succeeded",
    required: need("text"),
    outputs: [candidate("text", "ok")],
    at: AT,
  });
  // A drifted or corrupt store: an outcome outside the closed set. The read must
  // refuse it rather than cast it to a trusted AttemptOutcome (it would otherwise
  // reach the resume skip cursor and deriveRun).
  const runDbPath = join(groupDirOf(home), created.runId, "run.db");
  const raw = new Database(runDbPath);
  raw.exec("UPDATE attempt_log SET outcome = 'not-an-outcome'");
  raw.close();

  assert.throws(() => owner.attemptLog());
});

test("a garbage gate_answer.answer is rejected at the read, never trusted", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const recorded = owner.recordGateAnswer({
    operationId: "grant-1",
    gateAttemptId: "attempt-xyz",
    answer: "continue",
    iterationsAtGrant: 0,
    artifactName: "human-gate-answer",
    at: AT,
  });
  assert.ok(recorded.ok);
  const runDbPath = join(groupDirOf(home), created.runId, "run.db");
  const raw = new Database(runDbPath);
  raw.exec("UPDATE gate_answer SET answer = 'maybe'");
  raw.close();

  assert.throws(() => owner.gateAnswers());
});

// --- Diagnostics 90-day retention pruned at group open (A9, ADR 0023) --------

test("the latest Agent-step Attempt's Harness identity is durable across reopening (#125)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");

  {
    const owner = group.acquireRun(created.runId);
    assert.ok(owner !== undefined);
    // A Command/Gate Attempt records no Harness identity, so it never becomes the
    // latest Agent-step Attempt.
    owner.publishAttempt({
      attemptId: "0.0:setup",
      outcome: "succeeded",
      required: [],
      outputs: [],
      at: AT,
    });
    // An earlier Agent Attempt under one profile.
    owner.publishAttempt({
      attemptId: "0.1:repair",
      outcome: "failed",
      required: [],
      outputs: [],
      at: new Date("2026-09-12T12:00:01.000Z"),
      agentEvidence: {
        kind: "agent",
        identity: {
          harness: "Claude Code",
          executable: "/old/claude",
          executableVersion: "0.9.0",
          steer: { available: false, evidence: "old profile evidence" },
        },
      },
    });
    // The latest Agent Attempt under the profile the identity must report — with an
    // effective model observed for the same Attempt.
    owner.publishAttempt({
      attemptId: "0.2:repair",
      outcome: "succeeded",
      required: [],
      outputs: [],
      at: new Date("2026-09-12T12:00:02.000Z"),
      agentEvidence: {
        kind: "agent",
        effectiveModel: "claude-opus-5",
        identity: {
          harness: "Claude Code",
          executable: "/usr/bin/claude",
          executableVersion: "1.2.3",
          steer: { available: false, evidence: "print mode has no steer" },
        },
      },
    });
    assert.deepEqual(owner.harnessEvidence(), {
      identity: {
        harness: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
        steer: { available: false, evidence: "print mode has no steer" },
      },
      effectiveModel: "claude-opus-5",
    });
    owner.release();
    owner.close();
  }

  // Reopen the whole home: the durable identity reads back identically, and the
  // effective model stays the model authoritatively observed for that Attempt.
  group.close();
  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const owner2 = reopened.acquireRun(created.runId);
  assert.ok(owner2 !== undefined);
  t.after(() => owner2.close());
  assert.deepEqual(owner2.harnessEvidence(), {
    identity: {
      harness: "Claude Code",
      executable: "/usr/bin/claude",
      executableVersion: "1.2.3",
      steer: { available: false, evidence: "print mode has no steer" },
    },
    effectiveModel: "claude-opus-5",
  });
});

test("a Command-only Run has no Harness identity (#125)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());
  owner.publishAttempt({
    attemptId: "0.0:build",
    outcome: "succeeded",
    required: [],
    outputs: [],
    at: AT,
  });
  assert.equal(owner.harnessEvidence(), undefined);
});

test("a legacy model-only Attempt remains readable as co-sourced Harness evidence", (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-legacy-model");
  const owner = group.acquireRun(created.runId)!;
  owner.publishAttempt({
    attemptId: "0.0:legacy-agent",
    outcome: "succeeded",
    required: [],
    outputs: [],
    at: AT,
  });
  owner.close();

  const raw = new Database(join(groupDirOf(home), created.runId, "run.db"));
  raw
    .query("UPDATE attempt SET effective_model = ? WHERE attempt_id = ?")
    .run("legacy-model", "0.0:legacy-agent");
  raw.close();

  const reopened = group.acquireRun(created.runId)!;
  t.after(() => reopened.close());
  assert.deepEqual(reopened.harnessEvidence(), {
    effectiveModel: "legacy-model",
  });
});

test("a partial persisted steer capability is rejected at the Harness-identity read", (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-steer-corrupt");
  const owner = group.acquireRun(created.runId)!;
  owner.publishAttempt({
    attemptId: "0.0:repair",
    outcome: "succeeded",
    required: [],
    outputs: [],
    at: AT,
    agentEvidence: {
      kind: "agent",
      identity: {
        harness: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
        steer: { available: false, evidence: "profile evidence" },
      },
    },
  });
  owner.release();
  owner.close();

  const raw = new Database(join(groupDirOf(home), created.runId, "run.db"));
  raw
    .query("UPDATE attempt SET steer_evidence = NULL WHERE attempt_id = ?")
    .run("0.0:repair");
  raw.close();

  const corrupted = group.acquireRun(created.runId)!;
  t.after(() => corrupted.close());
  assert.throws(() => corrupted.harnessEvidence());
});
