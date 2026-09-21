import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { RunGroup } from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";
import { openFakeRunGroup as openRunGroup } from "./fake-git-process.js";

// #88 at the Run Store Interface: recording a Materialization conflict rests the
// Run `halted`, moves no binding, and never adopts Workspace bytes (the store has
// no Workspace access, so the invariant holds by construction); the diagnostic is
// retained and readable; and resume takes per-Run ownership (ADR 0031).

const AT = new Date("2026-09-13T12:00:00.000Z");
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes?: Uint8Array): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);
const candidate = (name: string, text: string) =>
  ({ name, type: "text", content: enc(text) }) as const;
const need = (...names: string[]) =>
  names.map((name) => ({ name, type: "text" }) as const);

function group(t: TestContext, workspace = "/work/project"): RunGroup {
  const home = makeTempDir("secant-store-conflict-");
  const runGroup = openRunGroup(home, workspace);
  t.after(() => runGroup.close());
  return runGroup;
}

function freshRun(g: RunGroup): string {
  const created = g.createRun({
    operationId: `op-${Math.random()}`,
    bundleSnapshotDigest: "sha256:deadbeef",
    launch: {},
    at: AT,
  });
  assert.ok(created.outcome === "created");
  return created.runId;
}

test("recording a conflict rests halted, moves no binding, is readable", (t) => {
  const g = group(t);
  const runId = freshRun(g);
  const owner = g.acquireRun(runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const published = owner.publishAttempt({
    attemptId: "a1",
    outcome: "succeeded",
    required: need("x"),
    outputs: [candidate("x", "bound-bytes")],
    at: AT,
  });
  assert.ok(published.ok && published.versionId);
  const boundVersion = owner.currentVersion("x");
  assert.equal(boundVersion, published.versionId);

  const recorded = owner.recordMaterializationConflict({
    artifactName: "x",
    path: "out/x.txt",
    versionId: boundVersion!,
    diagnostic: enc("copy changed at out/x.txt"),
    at: AT,
  });
  assert.ok(recorded.ok);

  // The Run rests halted, and the binding is exactly what it was before.
  const read = g.readRun(runId);
  assert.ok(read.ok);
  assert.equal(read.run.state, "halted");
  assert.equal(owner.currentVersion("x"), boundVersion);
  assert.equal(dec(owner.readArtifact(boundVersion!, "x")), "bound-bytes");

  // The conflict is listed with its fields, and its diagnostic is readable.
  const conflicts = owner.materializationConflicts();
  assert.equal(conflicts.length, 1);
  assert.deepEqual(
    {
      artifactName: conflicts[0]!.artifactName,
      path: conflicts[0]!.path,
      versionId: conflicts[0]!.versionId,
    },
    { artifactName: "x", path: "out/x.txt", versionId: boundVersion },
  );
  assert.equal(
    dec(owner.readDiagnostic(conflicts[0]!.diagnosticId)),
    "copy changed at out/x.txt",
  );
  assert.equal(owner.readDiagnostic("no-such-diagnostic"), undefined);
});

test("a fenced owner cannot record a conflict", (t) => {
  const g = group(t);
  const runId = freshRun(g);
  const stale = g.acquireRun(runId);
  assert.ok(stale);
  t.after(() => stale.close());
  const fresh = g.acquireRun(runId); // bumps the epoch, fencing `stale`
  assert.ok(fresh);
  t.after(() => fresh.close());

  const result = stale.recordMaterializationConflict({
    artifactName: "x",
    path: "out/x.txt",
    versionId: "v1",
    diagnostic: enc("detail"),
    at: AT,
  });
  assert.deepEqual(result, { ok: false, reason: "fenced" });
  // Nothing was recorded, and the Run was not halted by the refused write.
  assert.deepEqual(fresh.materializationConflicts(), []);
  const read = g.readRun(runId);
  assert.ok(read.ok);
  assert.notEqual(read.run.state, "halted");
});

test("resumeRun re-claims an unowned Run; another live Run does not block it (ADR 0031)", (t) => {
  const g = group(t);
  const runId = freshRun(g);
  // Already owned by this process (create owns it): an idempotent no-op claim.
  assert.deepEqual(g.resumeRun(runId), { outcome: "resumed", runId });

  // Release ownership, then resume re-claims it.
  g.endRun(runId);
  assert.ok(g.listRuns().every((run) => !run.live));
  assert.deepEqual(g.resumeRun(runId), { outcome: "resumed", runId });
  assert.ok(g.listRuns().some((run) => run.runId === runId && run.live));

  // Another live Run in the same Workspace does not block resuming this one:
  // ownership is per Run, not per Workspace.
  g.endRun(runId);
  freshRun(g); // a second live Run — no Workspace claim to contend
  assert.deepEqual(g.resumeRun(runId), { outcome: "resumed", runId });
  assert.equal(g.listRuns().filter((run) => run.live).length, 2);

  assert.deepEqual(g.resumeRun("no-such-run"), {
    outcome: "unknown-run",
    runId: "no-such-run",
  });
});
