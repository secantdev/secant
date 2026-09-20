import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";
import { openRunGroup, type RunGroup } from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";

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

test("a Turn is admitted, events append, and the result settles immutably (#116)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());

  const admitted = owner.admitTurn({
    turnId: "turn-1",
    attemptId: "0.0:write",
    session: "s",
    origin: "managed",
    kind: "agent",
    input: "do the thing at /abs/path.md",
    recoveryCoordinate: "native-abc",
    harness: "claude-code",
    at: AT,
  });
  assert.ok(admitted.ok);

  // The Turn row is admitted before any result, the Session reads `open`, and the
  // input is a `user` transcript entry. The Crucible Turn kind is recorded durably
  // (#126), independent of the `managed` origin.
  assert.equal(owner.turns().length, 1);
  assert.equal(owner.turns()[0]?.resultKind, undefined);
  assert.equal(owner.turns()[0]?.kind, "agent");
  assert.equal(owner.turns()[0]?.origin, "managed");
  assert.equal(owner.turns()[0]?.input, "do the thing at /abs/path.md");
  assert.deepEqual(owner.harnessSessions(), [
    { session: "s", availability: "open" },
  ]);
  assert.equal(owner.transcript()[0]?.role, "user");

  owner.appendTurnEvent({
    turnId: "turn-1",
    kind: "assistant-content",
    payload: JSON.stringify({ content: "hello" }),
    at: AT,
  });
  owner.appendTurnEvent({
    turnId: "turn-1",
    kind: "tool-activity",
    payload: JSON.stringify({ tool: "Edit", phase: "started" }),
    at: AT,
  });
  assert.equal(owner.turnEvents().length, 2);

  const settled = owner.settleTurn({
    turnId: "turn-1",
    session: "s",
    resultKind: "completed",
    resultDetail: JSON.stringify({ finalContent: "hello" }),
    availability: "open",
    assistantContent: "hello",
    at: AT,
  });
  assert.ok(settled.ok);
  assert.equal(owner.turns()[0]?.resultKind, "completed");
  assert.equal(
    owner.transcript().filter((entry) => entry.role === "assistant").length,
    1,
  );

  // A settled result is immutable: a second settle changes nothing.
  owner.settleTurn({
    turnId: "turn-1",
    session: "s",
    resultKind: "failed",
    resultDetail: "{}",
    availability: "unusable",
    at: AT,
  });
  assert.equal(owner.turns()[0]?.resultKind, "completed");
  assert.equal(owner.harnessSessions()[0]?.availability, "open");

  // The Attempt's effective model is readable once published.
  const published = owner.publishAttempt({
    attemptId: "0.0:write",
    outcome: "succeeded",
    required: [],
    outputs: [],
    at: AT,
    agentEvidence: {
      kind: "agent",
      effectiveModel: "claude-opus-5",
      identity: {
        harness: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
    },
  });
  assert.ok(published.ok);
  assert.equal(owner.harnessEvidence()?.effectiveModel, "claude-opus-5");
});

test("a fenced owner refuses every Turn-side write and the authored pending gate, writing nothing (A51)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const stale = group.acquireRun(created.runId)!;
  const fresh = group.acquireRun(created.runId)!; // bumps the epoch, fencing `stale`
  t.after(() => fresh.close());

  const fenced = { ok: false, reason: "fenced" };
  // Admission refused is what proves the Turn `not-started` (store/AGENTS.md): no
  // stdin is sent because no `turn` row exists.
  assert.deepEqual(
    stale.admitTurn({
      turnId: "turn-1",
      attemptId: "0.0:write",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: "do the thing",
      recoveryCoordinate: "native-abc",
      harness: "claude-code",
      at: AT,
    }),
    fenced,
  );
  assert.deepEqual(
    stale.appendTurnEvent({
      turnId: "turn-1",
      kind: "assistant-content",
      payload: JSON.stringify({ content: "hello" }),
      at: AT,
    }),
    fenced,
  );
  assert.deepEqual(
    stale.settleTurn({
      turnId: "turn-1",
      session: "s",
      resultKind: "completed",
      resultDetail: JSON.stringify({ kind: "completed" }),
      availability: "open",
      assistantContent: "hello",
      at: AT,
    }),
    fenced,
  );
  assert.deepEqual(
    stale.recordPendingGate({
      attemptId: "0.1:gate",
      stepId: "gate",
      shape: "approve-reject",
      message: "Ship it?",
      at: AT,
    }),
    fenced,
  );

  // Nothing landed: the fresh owner reads no Turn, no event, no Session, no
  // transcript entry, no pending gate, and the Run never rested `blocked`.
  assert.deepEqual(fresh.turns(), []);
  assert.deepEqual(fresh.turnEvents(), []);
  assert.deepEqual(fresh.harnessSessions(), []);
  assert.deepEqual(fresh.transcript(), []);
  assert.equal(fresh.pendingGate(), undefined);
  const read = group.readRun(created.runId);
  assert.ok(read.ok && read.run.state === "created");
});

test("settling a Turn records the detached and unusable Session availabilities with their detail (A51)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());

  const later = new Date(AT.getTime() + 1_000);
  const admit = (turnId: string, session: string, at: Date) =>
    owner.admitTurn({
      turnId,
      attemptId: `${turnId}:attempt`,
      session,
      origin: "managed",
      kind: "agent",
      input: `input for ${session}`,
      recoveryCoordinate: `native-${session}`,
      harness: "claude-code",
      at,
    });
  assert.ok(admit("turn-a", "s-a", AT).ok);
  assert.ok(admit("turn-b", "s-b", later).ok);
  assert.deepEqual(
    owner.harnessSessions().map((s) => s.availability),
    ["open", "open"],
  );

  // The process is closed when the Run rests and the Session becomes detached
  // with the resume id (spec #107): the shape execution writes for a completed
  // Turn whose Harness closes, carrying the recovery coordinate as the detail.
  assert.ok(
    owner.settleTurn({
      turnId: "turn-a",
      session: "s-a",
      resultKind: "completed",
      resultDetail: JSON.stringify({ kind: "completed" }),
      availability: "detached",
      availabilityDetail: "native-s-a",
      assistantContent: "done",
      at: later,
    }).ok,
  );
  // Recovery that fails leaves the Session `unusable`, its reason as the detail.
  assert.ok(
    owner.settleTurn({
      turnId: "turn-b",
      session: "s-b",
      resultKind: "failed",
      resultDetail: JSON.stringify({ kind: "failed" }),
      availability: "unusable",
      availabilityDetail: "resume-unacknowledged",
      at: later,
    }).ok,
  );

  assert.deepEqual(owner.harnessSessions(), [
    {
      session: "s-a",
      availability: "detached",
      availabilityDetail: "native-s-a",
    },
    {
      session: "s-b",
      availability: "unusable",
      availabilityDetail: "resume-unacknowledged",
    },
  ]);
  assert.deepEqual(
    owner.turns().map((turn) => turn.resultKind),
    ["completed", "failed"],
  );
});

test("Turn kind records both kinds in one Session, and a legacy row reads unknown (#126)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());

  // Two Interactive Turns then a following Agent Turn, all in one named Session —
  // the kind is Crucible truth independent of origin (`human`/`managed`).
  owner.admitTurn({
    turnId: "turn-1",
    attemptId: "0.0:discuss",
    session: "shared",
    origin: "human",
    kind: "interactive-agent",
    input: "let's talk",
    recoveryCoordinate: "native-1",
    harness: "claude-code",
    at: AT,
  });
  owner.admitTurn({
    turnId: "turn-2",
    attemptId: "0.0:discuss",
    session: "shared",
    origin: "human",
    kind: "interactive-agent",
    input: "one more thing",
    recoveryCoordinate: "native-1",
    harness: "claude-code",
    at: AT,
  });
  owner.admitTurn({
    turnId: "turn-3",
    attemptId: "0.0:build",
    session: "shared",
    origin: "managed",
    kind: "agent",
    input: "now build it",
    recoveryCoordinate: "native-1",
    harness: "claude-code",
    at: AT,
  });
  assert.deepEqual(
    owner.turns().map((turn) => turn.kind),
    ["interactive-agent", "interactive-agent", "agent"],
  );

  // A legacy row admitted before the kind column existed (a raw INSERT that omits
  // `kind`, so it is NULL) reads its kind back undefined — genuinely unknown, never
  // fabricated to a guess.
  const runDb = new Database(join(groupDirOf(home), created.runId, "run.db"));
  try {
    runDb
      .query(
        `INSERT INTO turn
           (turn_id, attempt_id, session_key, origin, sequence, input, admitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "turn-legacy",
        "legacy",
        "shared",
        "managed",
        3,
        "old turn",
        AT.toISOString(),
      );
  } finally {
    runDb.close();
  }
  const legacy = owner.turns().find((turn) => turn.turnId === "turn-legacy");
  assert.ok(legacy !== undefined);
  assert.equal(legacy.kind, undefined);
});

test("transcriptPage reads bounded, ordered pages and flags older history (#124)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());

  // Seed five user turns in one Session, and one in a second Session that must
  // never leak into the first Session's page.
  for (let i = 0; i < 5; i++) {
    owner.admitTurn({
      turnId: `t-${i}`,
      attemptId: "0.0:write",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: `input ${i}`,
      recoveryCoordinate: "native-abc",
      harness: "claude-code",
      at: AT,
    });
  }
  owner.admitTurn({
    turnId: "other",
    attemptId: "0.0:write",
    session: "other",
    origin: "managed",
    kind: "agent",
    input: "elsewhere",
    recoveryCoordinate: "native-xyz",
    harness: "claude-code",
    at: AT,
  });

  // The newest page is bounded, oldest-first within the page, and flags older.
  const newest = owner.transcriptPage({ session: "s", limit: 2 });
  assert.deepEqual(
    newest.entries.map((e) => e.content),
    ["input 3", "input 4"],
  );
  assert.equal(newest.hasOlder, true);

  // Paging upward with the oldest entry's seq walks older entries in order.
  const older = owner.transcriptPage({
    session: "s",
    before: newest.entries[0]!.seq,
    limit: 2,
  });
  assert.deepEqual(
    older.entries.map((e) => e.content),
    ["input 1", "input 2"],
  );
  assert.equal(older.hasOlder, true);

  // The final page has no older history and is not padded.
  const final = owner.transcriptPage({
    session: "s",
    before: older.entries[0]!.seq,
    limit: 2,
  });
  assert.deepEqual(
    final.entries.map((e) => e.content),
    ["input 0"],
  );
  assert.equal(final.hasOlder, false);

  // A non-positive limit is clamped to one entry so the page always carries a
  // cursor, rather than reporting older history over an empty page (A11). At HEAD
  // this returned `{ entries: [], hasOlder: true }`, which a pager cannot advance.
  const clamped = owner.transcriptPage({ session: "s", limit: 0 });
  assert.deepEqual(
    clamped.entries.map((e) => e.content),
    ["input 4"],
  );
  assert.equal(clamped.hasOlder, true);

  // An empty Session pages to nothing without throwing.
  assert.deepEqual(owner.transcriptPage({ session: "missing", limit: 2 }), {
    entries: [],
    hasOlder: false,
  });
});
