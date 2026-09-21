import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { TRANSCRIPT_PAGE_SIZE } from "../../src/application/application.js";
import type {
  TranscriptExportReference,
  TranscriptPageReference,
} from "../../src/application/projection-port.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import type { RunGroup } from "../../src/run/store/store.js";
import { createApplication, openRunGroup } from "../helpers/application.js";
import { hostPlatform } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";

const AT = new Date("2026-09-16T12:00:00.000Z");

// The transcript `page`/`export` Resource References (#124) resolved through the
// Projection Port: bounded ordered paging, the complete export, and normalized
// Problems for an unknown Run, Session, or cursor — never a native id or path.

function fixture(t: TestContext) {
  const catalog = openCatalog(makeTempDir("secant-tx-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-tx-ws-"));
  const runGroup = openRunGroup(makeTempDir("secant-tx-store-"), workspace);
  t.after(() => runGroup.close());
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution: () => {
      throw new Error("no execution in this test");
    },
  });
  return { app, runGroup };
}

/** Create a Run and seed `count` user Turns in one Session, plus one Turn in a
 *  second Session that must never leak into the first's page. */
function seedRun(runGroup: RunGroup, count: number): string {
  const created = runGroup.createRun({
    operationId: "op-1",
    bundleSnapshotDigest: "sha256:deadbeef",
    launch: { goal: "ship it" },
    at: AT,
  });
  const owner = runGroup.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  for (let i = 0; i < count; i++) {
    owner.admitTurn({
      turnId: `t-${i}`,
      attemptId: "0.0:write",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: `input ${i}`,
      recoveryCoordinate: "native",
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
    recoveryCoordinate: "native",
    harness: "claude-code",
    at: AT,
  });
  owner.close();
  return created.runId;
}

/** The transcript references for Session s. The Projection advertises the same
 *  shapes (asserted against a real Bundle in run-projection.test.ts); here they
 *  are built directly so the resolution paths do not need an installed Bundle. */
function pageRef(_app: ReturnType<typeof fixture>["app"], runId: string) {
  const page: TranscriptPageReference = {
    runId,
    session: "s",
    type: "transcript-page",
  };
  const exportRef: TranscriptExportReference = {
    runId,
    session: "s",
    type: "transcript-export",
  };
  return { page, export: exportRef };
}

test("a Session's transcript pages newest-first and flags older history (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const total = TRANSCRIPT_PAGE_SIZE * 2 + 3;
  const runId = seedRun(runGroup, total);
  const refs = pageRef(app, runId);

  const newest = app.projectionPort.readTranscript(refs.page);
  assert.ok(newest.found && newest.type === "transcript-page");
  assert.equal(newest.entries.length, TRANSCRIPT_PAGE_SIZE);
  assert.equal(newest.entries.at(-1)?.content, `input ${total - 1}`);
  assert.ok(newest.older, "an older cursor when more entries remain");
  // No entry from the other Session leaks in.
  assert.ok(newest.entries.every((e) => e.session === "s"));

  const middle = app.projectionPort.readTranscript({
    ...refs.page,
    older: newest.older,
  } as TranscriptPageReference);
  assert.ok(middle.found && middle.type === "transcript-page");
  assert.equal(middle.entries.length, TRANSCRIPT_PAGE_SIZE);
  assert.ok(middle.older);

  const final = app.projectionPort.readTranscript({
    ...refs.page,
    older: middle.older,
  } as TranscriptPageReference);
  assert.ok(final.found && final.type === "transcript-page");
  assert.equal(final.entries.length, 3);
  assert.equal(final.entries[0]?.content, "input 0");
  assert.equal(final.older, undefined, "no cursor on the final page");
});

test("a single-page transcript carries no older cursor (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 2);
  const refs = pageRef(app, runId);
  const page = app.projectionPort.readTranscript(refs.page);
  assert.ok(page.found && page.type === "transcript-page");
  assert.equal(page.entries.length, 2);
  assert.equal(page.older, undefined);
});

test("the export carries the complete retained transcript (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const total = TRANSCRIPT_PAGE_SIZE + 5;
  const runId = seedRun(runGroup, total);
  const refs = pageRef(app, runId);
  const read = app.projectionPort.readTranscript(refs.export);
  assert.ok(read.found && read.type === "transcript-export");
  assert.equal(read.entries.length, total);
  assert.equal(read.entries[0]?.content, "input 0");
  assert.equal(read.entries.at(-1)?.content, `input ${total - 1}`);
});

test("an invalid cursor is a normalized Problem, not a wrong page (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 3);
  const refs = pageRef(app, runId);
  const read = app.projectionPort.readTranscript({
    ...refs.page,
    older: "not-a-real-cursor",
  } as TranscriptPageReference);
  assert.ok(!read.found);
  assert.equal(read.problem.code, "run-transcript-cursor-invalid");

  // A well-formed but non-positive sequence is still a forged cursor, not an
  // empty page — store sequences are always positive.
  const negative = Buffer.from(JSON.stringify(-5)).toString("base64url");
  const bad = app.projectionPort.readTranscript({
    ...refs.page,
    older: negative,
  } as TranscriptPageReference);
  assert.ok(!bad.found);
  assert.equal(bad.problem.code, "run-transcript-cursor-invalid");
});

test("an unknown Session is a normalized Problem (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 3);
  const read = app.projectionPort.readTranscript({
    runId,
    session: "ghost",
    type: "transcript-page",
  });
  assert.ok(!read.found);
  assert.equal(read.problem.code, "run-session-not-found");
});

test("an unknown Run is a normalized Problem (#124)", (t) => {
  const { app } = fixture(t);
  const read = app.projectionPort.readTranscript({
    runId: "no-such-run",
    session: "s",
    type: "transcript-page",
  });
  assert.ok(!read.found);
});

test("a reopened Run still resolves transcript references (#124)", (t) => {
  const { app, runGroup } = fixture(t);
  const runId = seedRun(runGroup, 4);
  const refs = pageRef(app, runId);
  // Two independent reads acquire-and-close the rested Run each time.
  const first = app.projectionPort.readTranscript(refs.page);
  const second = app.projectionPort.readTranscript(refs.page);
  assert.ok(first.found && first.type === "transcript-page");
  assert.ok(second.found && second.type === "transcript-page");
  assert.deepEqual(
    first.entries.map((e) => e.content),
    second.entries.map((e) => e.content),
  );
});
