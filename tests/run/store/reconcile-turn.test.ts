import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import test from "node:test";
import { Database } from "bun:sqlite";
import { openRunGroup } from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";

const WORKSPACE = "/work/reconcile-turn-project";
const AT = new Date("2026-09-16T12:00:00.000Z");

/** The group directory Secant home resolves for the test Workspace. */
function groupDirOf(home: string): string {
  const runs = join(home, "runs");
  return join(runs, readdirSync(runs)[0]!);
}

test("startup reconciliation settles an admitted-but-unsettled Turn as lost/completion-unknown (#118)", (t) => {
  const home = makeTempDir("secant-reconcile-turn-");
  const group = openRunGroup(home, WORKSPACE);
  const created = group.createRun({
    operationId: "op-1",
    bundleSnapshotDigest: "sha256:deadbeef",
    launch: { goal: "ship it" },
    at: AT,
  });
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  assert.deepEqual(owner.writeState("running"), { ok: true }); // a live Run mid-Turn
  // Admit a Turn the way the Agent executor does, then never settle it: the owner
  // dies mid-Turn.
  assert.deepEqual(
    owner.admitTurn({
      turnId: "0.0:fix#turn",
      attemptId: "0.0:fix",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: "Repair the failing test.",
      recoveryCoordinate: "11111111-1111-4111-8111-111111111111",
      harness: "claude-code",
      at: AT,
    }),
    { ok: true },
  );
  owner.close();
  group.close(); // the launch process dies without ending the Run

  // Reopening the group reconciles the dead owner's Run: state -> halted, an
  // indeterminate Attempt marker, and the unsettled Turn -> lost.
  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const read = reopened.readRun(created.runId);
  assert.ok(read.ok);
  assert.equal(read.run.state, "halted");

  const owner2 = reopened.acquireRun(created.runId);
  assert.ok(owner2);
  t.after(() => owner2.close());
  assert.equal(owner2.attemptLog().at(-1)?.outcome, "indeterminate");

  const turns = owner2.turns();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.resultKind, "lost");
  assert.ok(turns[0]?.settledAt !== undefined);

  // The abandoned Turn's Session detaches to its stored coordinate (not left `open`),
  // so a later resume continues in the same Claude Code Session via `--resume` rather
  // than silently opening a fresh conversation (ADR 0022, #118).
  assert.deepEqual(owner2.harnessSessions(), [
    {
      session: "s",
      availability: "detached",
      availabilityDetail: "11111111-1111-4111-8111-111111111111",
    },
  ]);

  // The lost detail records completion-unknown. `turns()` does not expose the raw
  // result_detail, so read the row directly — the same byte-faithful store the
  // owner wrote.
  const runDb = new Database(join(groupDirOf(home), created.runId, "run.db"));
  try {
    const row = runDb
      .query("SELECT result_kind, result_detail FROM turn LIMIT 1")
      .get() as { result_kind: string; result_detail: string };
    assert.equal(row.result_kind, "lost");
    assert.deepEqual(JSON.parse(row.result_detail), {
      kind: "lost",
      unknown: "completion",
    });
  } finally {
    runDb.close();
  }
});
