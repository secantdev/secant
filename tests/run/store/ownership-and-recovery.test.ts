import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Database } from "bun:sqlite";
import type { RunGroup } from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";
import { openFakeRunGroup as openRunGroup } from "./fake-git-process.js";

const WORKSPACE = "/work/example-project";
const AT = new Date("2026-09-12T12:00:00.000Z");

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

test("two Runs live in one Workspace at once — create never refuses (ADR 0031)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());

  // No Workspace claim to contend: a second create while the first is live succeeds
  // and makes a distinct Run, each owned separately by this process.
  const first = create(group, "op-1");
  assert.ok(first.outcome === "created");
  const second = create(group, "op-2");
  assert.ok(second.outcome === "created");
  assert.notEqual(first.runId, second.runId);
  const listed = group.listRuns();
  assert.equal(listed.length, 2);
  assert.ok(listed.every((run) => run.live && run.ownedByThisProcess));
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

test("[new-run-harness-selection] create, replay, and reopen preserve selected Harness while Command-only stays unselected", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);

  const first = create(group, "op-agent", {
    selectedHarness: "claude-code",
  });
  assert.equal(first.record.selectedHarness, "claude-code");

  const replay = create(group, "op-agent", {
    selectedHarness: "claude-code",
  });
  assert.equal(replay.outcome, "already-created");
  assert.equal(replay.runId, first.runId);
  assert.equal(replay.record.selectedHarness, "claude-code");

  const commandOnly = create(group, "op-command");
  assert.equal(commandOnly.record.selectedHarness, undefined);
  const codex = create(group, "op-codex", { selectedHarness: "codex" });
  assert.equal(codex.record.selectedHarness, "codex");
  group.close();

  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const reopenedAgent = reopened.readRun(first.runId);
  assert.ok(reopenedAgent.ok);
  assert.equal(reopenedAgent.run.selectedHarness, "claude-code");
  const reopenedCommand = reopened.readRun(commandOnly.runId);
  assert.ok(reopenedCommand.ok);
  assert.equal(reopenedCommand.run.selectedHarness, undefined);
  const reopenedCodex = reopened.readRun(codex.runId);
  assert.ok(reopenedCodex.ok);
  assert.equal(reopenedCodex.run.selectedHarness, "codex");
});

test("an unknown persisted selected Harness makes the Run record unreadable", (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-agent", {
    selectedHarness: "claude-code",
  });

  const raw = new Database(join(groupDirOf(home), created.runId, "run.db"));
  raw.run("UPDATE run_record SET selected_harness = ?", ["unknown"]);
  raw.close();

  assert.deepEqual(group.readRun(created.runId), {
    ok: false,
    problem: { kind: "run-store-damaged", runId: created.runId },
  });
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

test("a takeover cannot cross an in-flight canonical write transaction", (t) => {
  const home = makeTempDir("secant-store-");
  const first = openRunGroup(home, WORKSPACE, { selfPid: 1000 });
  t.after(() => first.close());
  const created = create(first, "op-1");
  assert.ok(created.outcome === "created");
  const owner = first.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const second = openRunGroup(home, WORKSPACE, {
    selfPid: 2000,
    isOwnerAlive: (pid) => pid === 1000,
  });
  t.after(() => second.close());

  const runDatabase = new Database(
    join(groupDirOf(home), created.runId, "run.db"),
  );
  runDatabase.exec("BEGIN IMMEDIATE");
  try {
    const takeover = second.acquireRun(created.runId, { takeover: true });
    takeover?.close();
    assert.equal(takeover, undefined);
  } finally {
    runDatabase.exec("COMMIT");
    runDatabase.close();
  }

  assert.deepEqual(owner.writeState("running"), { ok: true });
});

test("a crash after staging leaves only a .creating quarantine the next open removes", async (t) => {
  const home = makeTempDir("secant-store-");
  // Poison the operations table so the admitted create faults on its INSERT,
  // after the run.db has been staged into `.creating` and before the rename.
  const groupDir = join(home, "runs", exampleGroupName());
  const bootstrap = openRunGroup(home, WORKSPACE);
  bootstrap.close();
  const raw = new Database(join(groupDir, "coordination.db"));
  raw.exec("DROP TABLE operations");
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

test("a coordination rebuild reopened by its owner reconciles the recovered owner", async (t) => {
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
  // Rebuilding recovered this process as the owner; startup reconciliation then
  // treats the matching pid as reused and releases it before listing.
  assert.equal(listed[0]!.live, false);
  const again = create(reopened, "op-2");
  assert.equal(again.outcome, "created");
});

test("a live Run owner survives a coordination database rebuild", (t) => {
  const home = makeTempDir("secant-store-");
  const first = openRunGroup(home, WORKSPACE, { selfPid: 1000 });
  const created = create(first, "op-1");
  assert.ok(created.outcome === "created");
  first.close();

  const groupDir = groupDirOf(home);
  writeFileSync(join(groupDir, "coordination.db"), "not a database at all");

  const second = openRunGroup(home, WORKSPACE, {
    selfPid: 2000,
    isOwnerAlive: (pid) => pid === 1000,
  });
  t.after(() => second.close());

  assert.deepEqual(second.listRuns(), [
    {
      runId: created.runId,
      live: true,
      ownerPid: 1000,
      ownedByThisProcess: false,
    },
  ]);
  assert.deepEqual(second.resumeRun(created.runId), {
    outcome: "run-live-elsewhere",
    runId: created.runId,
    ownerPid: 1000,
  });
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
  // Ownership was released by the reconcile: the Run is unowned before anyone
  // re-acquires it (acquiring would itself take ownership, ADR 0031).
  assert.equal(
    reopened.listRuns().find((run) => run.runId === created.runId)?.live,
    false,
  );
  // The interrupted Attempt is recorded indeterminate — nothing succeeded was
  // fabricated, so a resume re-runs from the interrupted Step.
  const owner2 = reopened.acquireRun(created.runId);
  assert.ok(owner2);
  t.after(() => owner2.close());
  assert.equal(owner2.attemptLog().at(-1)?.outcome, "indeterminate");
});

test("startup leaves a dead owner's blocked Run blocked and unowned (ADR 0031)", (t) => {
  // Ownership is held through `blocked` now, so a killed instance leaves a `blocked`
  // Run owned. Reconciliation splits by stored state: a `blocked` record is not a
  // cut-off Step (the process was only waiting on the checkpoint), so it stays
  // `blocked` — no indeterminate marker, no halt — with only its ownership released.
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  assert.deepEqual(owner.writeState("blocked"), { ok: true });
  owner.close();
  // The instance dies without ending the Run: ownership stays, the record `blocked`.
  group.close();

  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const read = reopened.readRun(created.runId);
  assert.ok(read.ok);
  assert.equal(read.run.state, "blocked"); // untouched: still blocked
  // Its ownership was released, so it is answerable/resumable again, not left live.
  assert.equal(
    reopened.listRuns().find((run) => run.runId === created.runId)?.live,
    false,
  );
  const owner2 = reopened.acquireRun(created.runId);
  assert.ok(owner2);
  t.after(() => owner2.close());
  assert.equal(owner2.attemptLog().length, 0); // no indeterminate marker appended
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
  assert.equal(listing?.ownedByThisProcess, false); // owned by pid 1000, not us
  // A live-elsewhere Run cannot be opened without taking over: a plain acquire is
  // declined (ADR 0031). Taking over reads the same store and confirms nothing was
  // reconciled — no indeterminate marker was appended.
  assert.equal(second.acquireRun(created.runId), undefined);
  const takenOver = second.acquireRun(created.runId, { takeover: true });
  assert.ok(takenOver);
  t.after(() => takenOver.close());
  assert.equal(takenOver.attemptLog().length, 0);
});

test("a live-owned Run refuses resume and a plain acquire, but takeover fences the owner (ADR 0031)", (t) => {
  // pid 1000 drives a Run; pid 2000 opens the same group with pid 1000 still alive.
  const home = makeTempDir("secant-store-");
  const first = openRunGroup(home, WORKSPACE, { selfPid: 1000 });
  t.after(() => first.close());
  const created = create(first, "op-1");
  assert.ok(created.outcome === "created");
  const owner1 = first.acquireRun(created.runId);
  assert.ok(owner1);
  t.after(() => owner1.close());
  assert.deepEqual(owner1.writeState("running"), { ok: true });

  const second = openRunGroup(home, WORKSPACE, {
    selfPid: 2000,
    isOwnerAlive: (pid) => pid === 1000,
  });
  t.after(() => second.close());

  // The courtesy probe refuses both resume and a plain acquire while pid 1000 lives.
  assert.deepEqual(second.resumeRun(created.runId), {
    outcome: "run-live-elsewhere",
    runId: created.runId,
    ownerPid: 1000,
  });
  assert.equal(second.acquireRun(created.runId), undefined);

  // A takeover fences pid 1000 regardless of the probe: owner1's next canonical
  // write is refused, owner2's succeeds.
  const owner2 = second.acquireRun(created.runId, { takeover: true });
  assert.ok(owner2);
  t.after(() => owner2.close());
  assert.deepEqual(owner1.writeState("cancelled"), {
    ok: false,
    reason: "fenced",
  });
  assert.deepEqual(owner1.release(), { ok: false, reason: "fenced" });
  assert.deepEqual(owner2.writeState("cancelled"), { ok: true });
  first.endRun(created.runId);
  // Ownership moved to pid 2000.
  const listing = second.listRuns().find((run) => run.runId === created.runId);
  assert.equal(listing?.ownerPid, 2000);
  assert.equal(listing?.ownedByThisProcess, true);
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

test("legacy Harness selection is idempotent and a fenced owner cannot change it", (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "legacy-create");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  assert.deepEqual(owner.selectHarness("claude-code"), {
    outcome: "selected",
  });
  assert.deepEqual(owner.selectHarness("claude-code"), {
    outcome: "already-selected",
  });
  const read = group.readRun(created.runId);
  assert.ok(read.ok);
  assert.equal(read.run.selectedHarness, "claude-code");

  const replacement = group.acquireRun(created.runId);
  assert.ok(replacement);
  t.after(() => replacement.close());
  assert.deepEqual(owner.selectHarness("claude-code"), {
    outcome: "fenced",
  });
});

test("a home created by the pre-Drizzle release migrates in place", (t) => {
  const home = makeTempDir("secant-store-migration-");
  const fixtureRuns = fileURLToPath(
    new URL("../../fixtures/pre-drizzle-home/runs", import.meta.url),
  );
  cpSync(fixtureRuns, join(home, "runs"), { recursive: true });

  const group = openRunGroup(home, "/fixture/workspace", {
    selfPid: 4242,
    isOwnerAlive: () => false,
  });
  t.after(() => group.close());
  const [listing] = group.listRuns();
  assert.ok(listing);
  const read = group.readRun(listing.runId);
  assert.ok(read.ok);
  assert.deepEqual(read.run.launch, { input: "fixture" });
  assert.equal(read.run.state, "halted");

  const created = create(group, "post-migration-create");
  assert.equal(created.outcome, "created");
  assert.equal(group.listRuns().length, 2);
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

function exampleGroupName(): string {
  const digest = createHash("sha256")
    .update(WORKSPACE)
    .digest("hex")
    .slice(0, 16);
  return `example-project--${digest}`;
}
