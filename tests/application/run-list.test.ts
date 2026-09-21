import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync as realpath } from "node:fs";
import test, { type TestContext } from "node:test";
import { type Application } from "../../src/application/application.js";
import type { RunListSnapshot } from "../../src/application/projection-port.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { createProcessAdapter } from "../../src/process/process.js";
import type { RunGroup } from "../../src/run/store/store.js";
import { createApplication, openRunGroup } from "../helpers/application.js";
import { hostPlatform, writeCommandBundle } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";

// A fixed clock so Today / Yesterday / Older grouping is deterministic on any CI
// timezone: rows are seeded relative to this same instant.
const NOW = new Date(2026, 5, 15, 12, 0, 0);
const executionProcess = createProcessAdapter();

interface Fixture {
  readonly app: Application;
  readonly catalog: Catalog;
  readonly runGroup: RunGroup;
  readonly workspace: string;
  readonly digest: string;
}

function fixture(t: TestContext): Fixture {
  const catalog = openCatalog(makeTempDir("secant-runlist-home-"));
  t.after(() => catalog.close());
  const workspace = realpath(makeTempDir("secant-runlist-ws-"));
  const runGroup = openRunGroup(
    makeTempDir("secant-runlist-store-"),
    workspace,
  );
  t.after(() => runGroup.close());
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution: ({ routing, owner }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process: executionProcess,
      }),
    now: () => NOW,
  });
  // Install one command Bundle; every seeded Run reuses its digest so the join can
  // derive a Bundle name from the pinned bytes.
  const cmd = writeCommandBundle();
  const built = app.bundleManagement.build(cmd.folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = catalog.listEntries().find((e) => e.id === cmd.id)!;
  return { app, catalog, runGroup, workspace, digest: entry.digest };
}

/** Seed a resting Run at `at` with canonical `state`, releasing the claim. */
function seedRun(f: Fixture, at: Date, state: string): string {
  const created = f.runGroup.createRun({
    operationId: randomUUID(),
    bundleSnapshotDigest: f.digest,
    launch: {},
    at,
  });
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") throw new Error("unreachable");
  const owner = f.runGroup.acquireRun(created.runId)!;
  owner.writeState(state);
  owner.close();
  f.runGroup.endRun(created.runId);
  return created.runId;
}

function list(
  app: Application,
  options: { resumable?: boolean; before?: string } = {},
): RunListSnapshot {
  const opened = app.projectionPort.openProjection({
    family: "run-list",
    ...(options.resumable ? { resumable: true } : {}),
    ...(options.before !== undefined ? { before: options.before } : {}),
  });
  const snapshot = opened.snapshot;
  opened.close();
  return snapshot;
}

test("run list orders newest first and groups Today / Yesterday / Older", async (t) => {
  const f = fixture(t);
  const older = seedRun(f, new Date(2026, 5, 10, 10, 0, 0), "succeeded");
  const yesterday = seedRun(f, new Date(2026, 5, 14, 10, 0, 0), "failed");
  const today = seedRun(f, new Date(2026, 5, 15, 10, 0, 0), "succeeded");

  const snapshot = list(f.app);
  assert.equal(snapshot.empty, false);
  assert.equal(snapshot.beginningOfHistory, true);
  assert.deepEqual(
    snapshot.rows.map((r) => r.runId),
    [today, yesterday, older],
  );
  assert.deepEqual(
    snapshot.rows.map((r) => r.group),
    ["today", "yesterday", "older"],
  );
  // Each row carries the Bundle's human name, not the digest.
  assert.ok(snapshot.rows.every((r) => r.bundleName.length > 0));
  assert.ok(snapshot.rows.every((r) => r.bundleName !== f.digest));
});

test("--resumable shows only halted and failed Runs", async (t) => {
  const f = fixture(t);
  seedRun(f, new Date(2026, 5, 15, 9, 0, 0), "succeeded");
  const failed = seedRun(f, new Date(2026, 5, 15, 10, 0, 0), "failed");
  const halted = seedRun(f, new Date(2026, 5, 15, 11, 0, 0), "halted");
  seedRun(f, new Date(2026, 5, 15, 8, 0, 0), "created");

  const snapshot = list(f.app, { resumable: true });
  assert.equal(snapshot.filter, "resumable");
  assert.deepEqual(
    new Set(snapshot.rows.map((r) => r.runId)),
    new Set([halted, failed]),
  );
});

test("Runs from another Workspace never appear", async (t) => {
  const f = fixture(t);
  const mine = seedRun(f, new Date(2026, 5, 15, 10, 0, 0), "succeeded");

  // A second Run group for a different Workspace under the same store home.
  const otherWs = realpath(makeTempDir("secant-runlist-other-ws-"));
  const otherGroup = openRunGroup(
    makeTempDir("secant-runlist-other-"),
    otherWs,
  );
  t.after(() => otherGroup.close());
  otherGroup.createRun({
    operationId: randomUUID(),
    bundleSnapshotDigest: f.digest,
    launch: {},
    at: new Date(2026, 5, 15, 11, 0, 0),
  });

  const snapshot = list(f.app);
  assert.deepEqual(
    snapshot.rows.map((r) => r.runId),
    [mine],
  );
});

test("the empty list is an informational snapshot", async (t) => {
  const f = fixture(t);
  const snapshot = list(f.app);
  assert.equal(snapshot.empty, true);
  assert.equal(snapshot.rows.length, 0);
  assert.equal(snapshot.beginningOfHistory, true);
  assert.equal(snapshot.nextCursor, undefined);
});

test("pages are bounded; the cursor pages older without duplicating or skipping, and the last page marks the beginning of history", async (t) => {
  const f = fixture(t);
  const total = 21;
  const ids: string[] = [];
  for (let i = 0; i < total; i++) {
    // Distinct, increasing creation times so the total order is stable.
    ids.push(seedRun(f, new Date(2026, 5, 15, 0, 0, i), "succeeded"));
  }

  const first = list(f.app);
  assert.equal(first.rows.length, 20);
  assert.ok(first.nextCursor);
  assert.equal(first.beginningOfHistory, false);

  const second = list(f.app, { before: first.nextCursor });
  assert.equal(second.rows.length, 1);
  assert.equal(second.nextCursor, undefined);
  assert.equal(second.beginningOfHistory, true);

  const seen = [...first.rows, ...second.rows].map((r) => r.runId);
  // No duplicates across pages, and the two pages cover every seeded Run exactly.
  assert.equal(new Set(seen).size, total);
  assert.deepEqual(new Set(seen), new Set(ids));
});

test("an unparseable cursor yields an empty page, not a throw or the whole list", async (t) => {
  const f = fixture(t);
  seedRun(f, new Date(2026, 5, 15, 10, 0, 0), "succeeded");

  const snapshot = list(f.app, { before: "not-a-real-cursor" });
  assert.equal(snapshot.rows.length, 0);
  // The list is not empty (a Run exists), so this is a past-the-end page, not the
  // informational empty snapshot, and it marks the beginning of history.
  assert.equal(snapshot.empty, false);
  assert.equal(snapshot.beginningOfHistory, true);
  assert.equal(snapshot.nextCursor, undefined);
});
