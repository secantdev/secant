import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createApplication } from "../../src/application/application.js";
import { type HeadlessIO, runHeadless } from "../../src/headless/headless.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { makeTempDir } from "../helpers/tempDir.js";

async function harness(t: TestContext) {
  const catalog = await openCatalog(makeTempDir("secant-headless-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-headless-ws-"));
  const clients = createApplication({
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
    clients,
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
  assert.equal(runHeadless(h.clients, ["workspace", "approve"], h.io), 0);

  h.reset();
  assert.equal(runHeadless(h.clients, ["workspace", "--json"], h.io), 0);
  const snapshot: unknown = JSON.parse(h.stdout());
  assert.deepEqual(snapshot, {
    family: "workspace",
    path: h.workspace,
    approval: {
      state: "approved",
      approvedAt: (snapshot as { approval: { approvedAt: string } }).approval
        .approvedAt,
    },
    installedBundleCount: 0,
    actionOffers: [],
  });
});

test("show on an unapproved workspace names the approve command", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["workspace"], h.io), 0);
  const text = h.stdout();
  assert.match(text, /unapproved/);
  assert.match(text, /secant workspace approve/);
});

test("approve --json prints the operation result verbatim", async (t) => {
  const h = await harness(t);
  assert.equal(
    runHeadless(h.clients, ["workspace", "approve", "--json"], h.io),
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
  assert.equal(
    runHeadless(h.clients, ["workspace", "approve", missing], h.io),
    1,
  );
  assert.match(h.stderr(), /workspace-path-not-found/);
  assert.match(h.stderr(), /Remediation:/);
  assert.equal(h.stdout(), "");
});

test("an unknown command exits non-zero with guidance", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["bundle", "list"], h.io), 1);
  assert.match(h.stderr(), /unknown-command/);
});

const proofBundle = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bundles",
  "test-repair-workflow",
);

test("bundle build --no-install --output prints the digest and output path", async (t) => {
  const h = await harness(t);
  const output = join(makeTempDir("secant-headless-wfb-"), "out.wfb");
  assert.equal(
    runHeadless(
      h.clients,
      ["bundle", "build", proofBundle, "--no-install", "--output", output],
      h.io,
    ),
    0,
  );
  assert.match(h.stdout(), /Digest: sha256:[0-9a-f]{64}/);
  assert.match(
    h.stdout(),
    new RegExp(`Wrote ${output.replace(/[.\\]/g, "\\$&")}`),
  );
  assert.ok(existsSync(output));
});

test("bundle build parses the folder even when flags precede it", async (t) => {
  const h = await harness(t);
  const output = join(makeTempDir("secant-headless-wfb-"), "out.wfb");
  assert.equal(
    runHeadless(
      h.clients,
      ["bundle", "build", "--no-install", "--output", output, proofBundle],
      h.io,
    ),
    0,
  );
  assert.match(h.stdout(), /Digest: sha256:[0-9a-f]{64}/);
  assert.ok(existsSync(output));
});

test("bundle build on a non-composing folder exits non-zero, prints the findings, and writes nothing", async (t) => {
  const h = await harness(t);
  const folder = makeTempDir("secant-headless-noncompose-");
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id: "io.example.x",
        version: "1.0.0",
        name: "X",
        description: "x",
      },
      inputs: {},
      assets: [{ path: "p.md", kind: "prompt" }],
      routing: [
        {
          repeat: {
            until: "never-bound",
            reviewCheckpoint: { interval: 1, message: "continue?" },
            steps: [
              {
                id: "a",
                kind: "agent",
                session: "s",
                prompt: { asset: "p.md" },
              },
            ],
          },
        },
      ],
    }),
  );
  writeFileSync(join(folder, "p.md"), "do the work");

  const output = join(makeTempDir("secant-headless-wfb-"), "out.wfb");
  assert.equal(
    runHeadless(
      h.clients,
      ["bundle", "build", folder, "--no-install", "--output", output],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /composition-check-failed/);
  assert.match(h.stderr(), /verdict-unbound-before-entry/);
  assert.equal(existsSync(output), false);
  assert.equal(h.stdout(), "");
});

test("bundle build --no-install without --output refuses with a Problem", async (t) => {
  const h = await harness(t);
  assert.equal(
    runHeadless(
      h.clients,
      ["bundle", "build", proofBundle, "--no-install"],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /output-required/);
});

test("bundle build installs by default and the Home count reads back one", async (t) => {
  const h = await harness(t);
  assert.equal(
    runHeadless(h.clients, ["bundle", "build", proofBundle], h.io),
    0,
  );
  assert.match(h.stdout(), /Bundle: dev\.secant\.test-repair@1\.0\.0/);
  assert.match(h.stdout(), /Installed \(generation 1\)/);

  h.reset();
  assert.equal(runHeadless(h.clients, ["workspace", "--json"], h.io), 0);
  const snapshot = JSON.parse(h.stdout()) as { installedBundleCount: number };
  assert.equal(snapshot.installedBundleCount, 1);
});

test("bundle install of the built file reports already installed", async (t) => {
  const h = await harness(t);
  const output = join(makeTempDir("secant-headless-wfb-"), "out.wfb");
  assert.equal(
    runHeadless(
      h.clients,
      ["bundle", "build", proofBundle, "--output", output],
      h.io,
    ),
    0,
  );
  assert.ok(existsSync(output));

  h.reset();
  assert.equal(runHeadless(h.clients, ["bundle", "install", output], h.io), 0);
  assert.match(h.stdout(), /Already installed/);
});
