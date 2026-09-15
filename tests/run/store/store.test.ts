import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  overrides: { digest?: string; launch?: unknown } = {},
) {
  return group.createRun({
    operationId,
    bundleSnapshotDigest: overrides.digest ?? "sha256:deadbeef",
    launch: overrides.launch ?? { goal: "ship it" },
    at: AT,
  });
}

/** The group directory Secant home resolves for the test Workspace. */
function groupDirOf(home: string): string {
  const runs = join(home, "runs");
  return join(runs, readdirSync(runs)[0]!);
}

test("creating a Run produces the grouped directory and its store", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());

  const result = create(group, "op-1");
  assert.equal(result.outcome, "created");
  assert.ok(result.outcome === "created");
  assert.deepEqual(result.record.launch, { goal: "ship it" });
  assert.equal(result.record.workspacePath, WORKSPACE);
  assert.equal(result.record.bundleSnapshotDigest, "sha256:deadbeef");

  const runs = readdirSync(join(home, "runs"));
  assert.equal(runs.length, 1);
  const [slugDigest] = runs;
  assert.match(slugDigest!, /^example-project--[0-9a-f]{16}$/);

  const runDir = join(home, "runs", slugDigest!, result.runId);
  assert.ok(existsSync(join(runDir, "run.db")));
  assert.ok(existsSync(join(runDir, "staging")));
  assert.ok(existsSync(join(runDir, "diagnostics")));

  const read = group.readRun(result.runId);
  assert.ok(read.ok);
  assert.deepEqual(read.run, result.record);
});

test("a second create while a Run is live is refused with a Problem", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());

  const first = create(group, "op-1");
  assert.ok(first.outcome === "created");
  const second = create(group, "op-2");
  assert.equal(second.outcome, "workspace-busy");
  assert.ok(second.outcome === "workspace-busy");
  assert.equal(second.liveRunId, first.runId);
  assert.equal(group.listRuns().length, 1);
});

test("create is idempotent per operation id", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());

  const first = create(group, "op-1");
  const replay = create(group, "op-1");
  assert.ok(first.outcome === "created");
  assert.equal(replay.outcome, "already-created");
  assert.ok(replay.outcome === "already-created");
  assert.equal(replay.runId, first.runId);
  assert.equal(
    readdirSync(groupDirOf(home)).filter((n) => !n.endsWith(".db")).length,
    1,
  );
});

test("delete releases the claim so the Workspace can host a new Run", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());

  const first = create(group, "op-1");
  assert.ok(first.outcome === "created");
  const deleted = group.deleteRun({
    operationId: "op-del",
    runId: first.runId,
  });
  assert.equal(deleted.outcome, "deleted");
  assert.equal(group.listRuns().length, 0);
  // The run directory was reclaimed.
  assert.ok(!existsSync(join(groupDirOf(home), first.runId)));

  const second = create(group, "op-2");
  assert.equal(second.outcome, "created");
});

test("delete is idempotent per operation id, even for an absent Run", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());

  const first = create(group, "op-1");
  assert.ok(first.outcome === "created");
  const a = group.deleteRun({ operationId: "op-del", runId: first.runId });
  const b = group.deleteRun({ operationId: "op-del", runId: first.runId });
  assert.equal(a.outcome, "deleted");
  assert.equal(b.outcome, "already-deleted");

  // Deleting a Run that never existed still succeeds (nothing to release).
  const c = group.deleteRun({ operationId: "op-ghost", runId: "no-such-run" });
  assert.equal(c.outcome, "deleted");
});

test("a stale owner cannot write after being fenced", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());

  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");

  const stale = group.acquireRun(created.runId);
  assert.ok(stale);
  t.after(() => stale.close());
  assert.deepEqual(stale.writeState("running"), { ok: true });

  // A second acquisition fences the first: its epoch is now behind.
  const fresh = group.acquireRun(created.runId);
  assert.ok(fresh);
  t.after(() => fresh.close());
  assert.deepEqual(stale.writeState("cancelled"), {
    ok: false,
    reason: "fenced",
  });
  assert.deepEqual(fresh.writeState("done"), { ok: true });

  const read = group.readRun(created.runId);
  assert.ok(read.ok);
  assert.equal(read.run.state, "done");
});

test("a crash after staging leaves only a .creating quarantine the next open removes", async (t) => {
  const home = makeTempDir("secant-store-");
  // Poison the operations table so the admitted create faults on its INSERT,
  // after the run.db has been staged into `.creating` and before the rename.
  const groupDir = join(home, "runs", exampleGroupName());
  mkdirSync(groupDir, { recursive: true });
  const raw = new Database(join(groupDir, "coordination.db"));
  raw.exec(
    "CREATE TABLE runs (run_id TEXT PRIMARY KEY, state TEXT NOT NULL, " +
      "owner_epoch INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT",
  );
  raw.exec(
    "CREATE UNIQUE INDEX one_live_run ON runs(state) WHERE state = 'live'",
  );
  raw.exec(
    "CREATE TABLE operations (operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, " +
      "run_id TEXT NOT NULL, recorded_at TEXT NOT NULL, CHECK (0)) STRICT",
  );
  raw.close();

  const group = openRunGroup(home, WORKSPACE);
  assert.throws(() => create(group, "op-1"));
  // The staged store remains as a `.creating` quarantine; nothing was published.
  const quarantines = readdirSync(groupDir).filter((n) =>
    n.endsWith(".creating"),
  );
  assert.equal(quarantines.length, 1);
  assert.equal(group.listRuns().length, 0);
  group.close();

  // The next open removes the quarantine.
  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  assert.equal(
    readdirSync(groupDir).filter((n) => n.endsWith(".creating")).length,
    0,
  );
});

test("a .deleting quarantine from a crashed delete is removed on the next open", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  group.close();

  // Simulate a delete that crashed after moving the store to its `.deleting`
  // quarantine but before reclaiming it.
  const groupDir = groupDirOf(home);
  renameSync(
    join(groupDir, created.runId),
    join(groupDir, `${created.runId}.deleting`),
  );

  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  assert.equal(
    readdirSync(groupDir).filter((n) => n.endsWith(".deleting")).length,
    0,
  );
});

test("an unregistered Run directory left by a crashed delete is swept on the next open", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  group.close();

  // Simulate a delete that committed (registration gone) but crashed before its
  // directory was reclaimed: an intact coordination DB no longer lists the Run.
  const groupDir = groupDirOf(home);
  const raw = new Database(join(groupDir, "coordination.db"));
  raw.run("DELETE FROM runs WHERE run_id = ?", [created.runId]);
  raw.close();
  assert.ok(existsSync(join(groupDir, created.runId)));

  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  // The orphan directory is gone, and it is not resurrected as a Run.
  assert.ok(!existsSync(join(groupDir, created.runId)));
  assert.equal(reopened.listRuns().length, 0);
});

test("an owned Run can still be deleted; the handle is closed before reclaim", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());

  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const deleted = group.deleteRun({
    operationId: "op-del",
    runId: created.runId,
  });
  assert.equal(deleted.outcome, "deleted");
  assert.ok(!existsSync(join(groupDirOf(home), created.runId)));
  // The now-orphaned owner is fenced out of further canonical writes.
  assert.deepEqual(owner.writeState("running"), {
    ok: false,
    reason: "fenced",
  });
});

test("a create retried long after the Run was deleted starts a fresh Run", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());

  const first = create(group, "op-1");
  assert.ok(first.outcome === "created");
  group.deleteRun({ operationId: "op-del", runId: first.runId });
  // Replaying the original create id no longer maps to the deleted Run.
  const retry = create(group, "op-1");
  assert.equal(retry.outcome, "created");
  assert.ok(retry.outcome === "created");
  assert.notEqual(retry.runId, first.runId);
});

test("a corrupt coordination.db is rebuilt from readable Run Stores with no owner or claim", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  group.close();

  // Corrupt the coordination database.
  const groupDir = groupDirOf(home);
  writeFileSync(join(groupDir, "coordination.db"), "not a database at all");

  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const listed = reopened.listRuns();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.runId, created.runId);
  // Rebuilt with no claim: the Workspace is free, so a fresh create is admitted.
  assert.equal(listed[0]!.live, false);
  const again = create(reopened, "op-2");
  assert.equal(again.outcome, "created");
});

test("a corrupt run.db reports a Problem for that Run while siblings stay readable", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  const a = create(group, "op-a");
  assert.ok(a.outcome === "created");
  // End Run a (its store persists) so a sibling Run can share the group.
  group.endRun(a.runId);
  const b = create(group, "op-b");
  assert.ok(b.outcome === "created");
  group.close();

  // Corrupt only Run b's store.
  const groupDir = groupDirOf(home);
  writeFileSync(join(groupDir, b.runId, "run.db"), "garbage");

  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const problem = reopened.readRun(b.runId);
  assert.ok(!problem.ok);
  assert.deepEqual(problem.problem, {
    kind: "run-store-damaged",
    runId: b.runId,
  });
  // The sibling stays fully readable.
  const sibling = reopened.readRun(a.runId);
  assert.ok(sibling.ok);
  assert.equal(sibling.run.runId, a.runId);
});

test("startup reconciles a stale-claimed running Run to halted with an indeterminate Attempt (#86)", (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  assert.deepEqual(owner.writeState("running"), { ok: true }); // a live Run mid-flight
  owner.close();
  // The launch process dies without ending the Run: the claim stays live and the
  // record stays `running`, exactly as a killed process leaves them.
  group.close();

  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const read = reopened.readRun(created.runId);
  assert.ok(read.ok);
  assert.equal(read.run.state, "halted");
  // The interrupted Attempt is recorded indeterminate — nothing succeeded was
  // fabricated, so a resume re-runs from the interrupted Step.
  const owner2 = reopened.acquireRun(created.runId);
  assert.ok(owner2);
  t.after(() => owner2.close());
  const log = owner2.attemptLog();
  assert.equal(log.at(-1)?.outcome, "indeterminate");
  // The stale claim was released: the Workspace is free again.
  assert.equal(
    reopened.listRuns().find((run) => run.runId === created.runId)?.live,
    false,
  );
});

test("startup leaves a Run whose claim was cleanly released untouched (#86)", (t) => {
  // A derived-`blocked` Run is stored `running` but has released its claim, so it
  // must not be reconciled: the claim, not the stored state, marks a killed Run.
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  assert.deepEqual(owner.writeState("running"), { ok: true });
  owner.close();
  group.endRun(created.runId); // a clean rest releases the claim
  group.close();

  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const read = reopened.readRun(created.runId);
  assert.ok(read.ok);
  assert.equal(read.run.state, "running"); // untouched: no indeterminate, no halt
  const owner2 = reopened.acquireRun(created.runId);
  assert.ok(owner2);
  t.after(() => owner2.close());
  assert.equal(owner2.attemptLog().length, 0);
});

test("startup leaves a Run whose owner process is still alive live and unaltered (#98 S2)", (t) => {
  // A first process (pid 1000) launches a Run and leaves it live, then a second
  // process (pid 2000) opens the same group while pid 1000 is still alive. The live
  // claim is a Run genuinely executing elsewhere, so it is left live and unaltered —
  // never reconciled — and is listed live, naming its owner.
  const home = makeTempDir("secant-store-");
  const first = openRunGroup(home, WORKSPACE, { selfPid: 1000 });
  const created = create(first, "op-1");
  assert.ok(created.outcome === "created");
  const owner = first.acquireRun(created.runId);
  assert.ok(owner);
  assert.deepEqual(owner.writeState("running"), { ok: true });
  owner.close();
  first.close(); // the first process's handle closes, but its claim stays live

  const second = openRunGroup(home, WORKSPACE, {
    selfPid: 2000,
    isOwnerAlive: (pid) => pid === 1000, // pid 1000 is still running
  });
  t.after(() => second.close());
  const read = second.readRun(created.runId);
  assert.ok(read.ok);
  assert.equal(read.run.state, "running"); // untouched: not reconciled to halted
  const listing = second.listRuns().find((run) => run.runId === created.runId);
  assert.equal(listing?.live, true);
  assert.equal(listing?.ownerPid, 1000); // the owner is named for a live-elsewhere refusal
  // No indeterminate marker was appended — the Run was never reconciled.
  const owner2 = second.acquireRun(created.runId);
  assert.ok(owner2);
  t.after(() => owner2.close());
  assert.equal(owner2.attemptLog().length, 0);
});

test("startup reconciles a Run whose owner process is dead to halted (#98 S2)", (t) => {
  // The same setup, but pid 1000 is gone when the second process opens: a dead owner
  // is reconciled `halted` with the indeterminate marker, exactly as before.
  const home = makeTempDir("secant-store-");
  const first = openRunGroup(home, WORKSPACE, { selfPid: 1000 });
  const created = create(first, "op-1");
  assert.ok(created.outcome === "created");
  const owner = first.acquireRun(created.runId);
  assert.ok(owner);
  assert.deepEqual(owner.writeState("running"), { ok: true });
  owner.close();
  first.close();

  const second = openRunGroup(home, WORKSPACE, {
    selfPid: 2000,
    isOwnerAlive: () => false, // pid 1000 is dead
  });
  t.after(() => second.close());
  const read = second.readRun(created.runId);
  assert.ok(read.ok);
  assert.equal(read.run.state, "halted");
  assert.equal(
    second.listRuns().find((run) => run.runId === created.runId)?.live,
    false,
  );
  const owner2 = second.acquireRun(created.runId);
  assert.ok(owner2);
  t.after(() => owner2.close());
  assert.equal(owner2.attemptLog().at(-1)?.outcome, "indeterminate");
});

test("canonical truth survives reopening the same home", async (t) => {
  const home = makeTempDir("secant-store-");
  const first = openRunGroup(home, WORKSPACE);
  const created = create(first, "op-1", { launch: { pinned: true } });
  assert.ok(created.outcome === "created");
  first.close();

  const second = openRunGroup(home, WORKSPACE);
  t.after(() => second.close());
  const read = second.readRun(created.runId);
  assert.ok(read.ok);
  assert.deepEqual(read.run.launch, { pinned: true });
  assert.equal(read.run.bundleSnapshotDigest, "sha256:deadbeef");
});

test("SECANT_HOME-style separate homes keep separate Workspaces apart", async (t) => {
  const home = makeTempDir("secant-store-");
  const groupA = openRunGroup(home, "/work/project-a");
  const groupB = openRunGroup(home, "/work/project-b");
  t.after(() => {
    groupA.close();
    groupB.close();
  });

  const a = create(groupA, "op-a");
  const b = create(groupB, "op-b");
  assert.equal(a.outcome, "created");
  assert.equal(b.outcome, "created");
  // Two distinct group directories, each with one live Run.
  assert.equal(readdirSync(join(home, "runs")).length, 2);
  assert.equal(groupA.listRuns().length, 1);
  assert.equal(groupB.listRuns().length, 1);
});

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

test("group open prunes diagnostics older than 90 days and keeps newer ones", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  group.close();

  const diagnosticsDir = join(groupDirOf(home), created.runId, "diagnostics");
  const stale = join(diagnosticsDir, "stale-diagnostic");
  const fresh = join(diagnosticsDir, "fresh-diagnostic");
  writeFileSync(stale, "old conflict detail");
  writeFileSync(fresh, "recent conflict detail");
  const now = new Date("2026-09-14T00:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;
  // 100 days old (past the 90-day window) and 10 days old (inside it).
  const staleTime = new Date(now.getTime() - 100 * day);
  const freshTime = new Date(now.getTime() - 10 * day);
  utimesSync(stale, staleTime, staleTime);
  utimesSync(fresh, freshTime, freshTime);

  // Reopen against the injected clock: the prune runs at open.
  const reopened = openRunGroup(home, WORKSPACE, { now: () => now });
  t.after(() => reopened.close());

  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

/** The `<slug>--<digest>` directory openRunGroup derives for WORKSPACE, recomputed
 *  here so the poisoned-coordination test can pre-seed it. */
function exampleGroupName(): string {
  const digest = createHash("sha256")
    .update(WORKSPACE)
    .digest("hex")
    .slice(0, 16);
  return `example-project--${digest}`;
}
