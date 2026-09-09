import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApplication } from "../../src/application/application.js";
import { type HeadlessIO, runHeadless } from "../../src/headless/headless.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { makeTempDir } from "../helpers/tempDir.js";

async function harness(t: TestContext) {
  const catalog = await openCatalog(makeTempDir("secant-headless-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-headless-ws-"));
  const { projectionPort } = createApplication({
    catalog,
    launchWorkspacePath: workspace,
  });
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: () => workspace,
  };
  return {
    port: projectionPort,
    workspace,
    io,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

test("approve then show --json reports approved with the canonical path", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.port, ["workspace", "approve"], h.io), 0);

  h.reset();
  assert.equal(runHeadless(h.port, ["workspace", "--json"], h.io), 0);
  const snapshot: unknown = JSON.parse(h.stdout());
  assert.deepEqual(snapshot, {
    family: "workspace",
    path: h.workspace,
    approval: {
      state: "approved",
      approvedAt: (snapshot as { approval: { approvedAt: string } }).approval
        .approvedAt,
    },
    actionOffers: [],
  });
});

test("show on an unapproved workspace names the approve command", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.port, ["workspace"], h.io), 0);
  const text = h.stdout();
  assert.match(text, /unapproved/);
  assert.match(text, /secant workspace approve/);
});

test("approve --json prints the operation result verbatim", async (t) => {
  const h = await harness(t);
  assert.equal(
    runHeadless(h.port, ["workspace", "approve", "--json"], h.io),
    0,
  );
  const snapshot: unknown = JSON.parse(h.stdout());
  assert.equal((snapshot as { family: string }).family, "operation");
  assert.deepEqual((snapshot as { outcome: unknown }).outcome, {
    status: "applied",
  });
});

test("approving a missing path exits non-zero and prints the Problem", async (t) => {
  const h = await harness(t);
  const missing = join(makeTempDir("secant-headless-missing-"), "nope");
  assert.equal(runHeadless(h.port, ["workspace", "approve", missing], h.io), 1);
  assert.match(h.stderr(), /workspace-path-not-found/);
  assert.match(h.stderr(), /Remediation:/);
  assert.equal(h.stdout(), "");
});

test("an unknown command exits non-zero with guidance", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.port, ["bundle", "list"], h.io), 1);
  assert.match(h.stderr(), /unknown-command/);
});
