import assert from "node:assert/strict";
import test from "node:test";
import { openCatalog } from "../../src/catalog/catalog.js";
import { makeTempDir } from "../helpers/tempDir.js";

test("an approval is recorded and read back over a temporary home", async (t) => {
  const catalog = await openCatalog(makeTempDir("secant-catalog-"));
  t.after(() => catalog.close());

  assert.equal(catalog.getWorkspaceApproval("/tmp/ws"), undefined);
  const record = catalog.approveWorkspace(
    "/tmp/ws",
    new Date("2026-09-09T10:00:00.000Z"),
  );
  assert.deepEqual(record, {
    path: "/tmp/ws",
    approvedAt: "2026-09-09T10:00:00.000Z",
  });
  assert.deepEqual(catalog.getWorkspaceApproval("/tmp/ws"), record);
});

test("re-approving keeps the first time and writes no second record", async (t) => {
  const catalog = await openCatalog(makeTempDir("secant-catalog-"));
  t.after(() => catalog.close());

  const first = catalog.approveWorkspace(
    "/tmp/ws",
    new Date("2026-01-01T00:00:00.000Z"),
  );
  const second = catalog.approveWorkspace(
    "/tmp/ws",
    new Date("2026-02-02T00:00:00.000Z"),
  );
  assert.deepEqual(second, first);
});

test("approvals survive reopening the same home", async (t) => {
  const home = makeTempDir("secant-catalog-");
  const first = await openCatalog(home);
  first.approveWorkspace("/tmp/ws", new Date("2026-03-03T00:00:00.000Z"));
  first.close();

  const second = await openCatalog(home);
  t.after(() => second.close());
  assert.equal(
    second.getWorkspaceApproval("/tmp/ws")?.approvedAt,
    "2026-03-03T00:00:00.000Z",
  );
});
