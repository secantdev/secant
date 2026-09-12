import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
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
    catalog,
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

test("workspace approve <relative> resolves against io.cwd(), not process.cwd()", async (t) => {
  // The launch Workspace is a child directory; io.cwd() is its parent. Approving
  // it by the relative name "sub" must resolve against io.cwd() (#74 A5): if it
  // resolved against the process cwd instead, "sub" would miss the launch
  // Workspace and it would never read approved.
  const catalog = await openCatalog(makeTempDir("secant-approve-home-"));
  t.after(() => catalog.close());
  const parent = realpathSync.native(makeTempDir("secant-approve-parent-"));
  const child = join(parent, "sub");
  mkdirSync(child);
  const clients = createApplication({ catalog, launchWorkspacePath: child });
  const out: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: () => {},
    cwd: () => parent,
  };

  assert.equal(runHeadless(clients, ["workspace", "approve", "sub"], io), 0);

  out.length = 0;
  assert.equal(runHeadless(clients, ["workspace", "--json"], io), 0);
  const snapshot = JSON.parse(out.join("")) as {
    approval: { state: string };
  };
  assert.equal(snapshot.approval.state, "approved");
});

test("an unknown command exits non-zero with guidance", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["bundle", "frobnicate"], h.io), 1);
  assert.match(h.stderr(), /unknown-command/);
});

test("an unknown top-level command exits non-zero", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["frobnicate"], h.io), 1);
  assert.match(h.stderr(), /unknown-command/);
});

test("an unknown flag exits non-zero", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["bundle", "list", "--bogus"], h.io), 1);
  assert.match(h.stderr(), /unknown-option/);
});

test("--help lists every command, including bundle install, and exits zero", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["--help"], h.io), 0);
  const text = h.stdout();
  assert.match(text, /Usage: secant/);
  for (const command of [
    "workspace",
    "workspace approve",
    "bundle list",
    "bundle inspect",
    "bundle build",
    "bundle install",
  ]) {
    assert.match(text, new RegExp(command.replace(/ /g, "\\s")));
  }
  assert.equal(h.stderr(), "");
});

test("a subcommand's --help prints that subcommand and exits zero", async (t) => {
  const h = await harness(t);
  assert.equal(
    runHeadless(h.clients, ["bundle", "inspect", "--help"], h.io),
    0,
  );
  assert.match(h.stdout(), /secant bundle inspect/);
  assert.match(h.stdout(), /id@version/);
});

test("--version prints the embedded version and exits zero", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["--version"], h.io), 0);
  assert.equal(h.stdout(), "0.0.0-dev\n");
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
  assert.match(h.stdout(), /^Installed\.$/m);

  h.reset();
  assert.equal(runHeadless(h.clients, ["workspace", "--json"], h.io), 0);
  const snapshot = JSON.parse(h.stdout()) as { installedBundleCount: number };
  assert.equal(snapshot.installedBundleCount, 1);
});

test("bundle list shows the installed row and --json carries the snapshot", async (t) => {
  const h = await harness(t);
  assert.equal(
    runHeadless(h.clients, ["bundle", "build", proofBundle], h.io),
    0,
  );

  h.reset();
  assert.equal(runHeadless(h.clients, ["bundle", "list"], h.io), 0);
  const text = h.stdout();
  assert.match(text, /dev\.secant\.test-repair@1\.0\.0/);
  assert.match(text, /digest: sha256:[0-9a-f]{64}/);
  assert.match(text, /platforms: windows, macos, linux/);
  assert.match(text, /not yet trusted/);

  h.reset();
  assert.equal(runHeadless(h.clients, ["bundle", "list", "--json"], h.io), 0);
  const snapshot = JSON.parse(h.stdout()) as {
    family: string;
    result: { found: boolean; bundles: { id: string }[] };
  };
  assert.equal(snapshot.family, "bundle-catalog");
  assert.equal(snapshot.result.bundles[0].id, "dev.secant.test-repair");
});

test("bundle list and inspect show a trusted Bundle once a grant is recorded", async (t) => {
  const h = await harness(t);
  assert.equal(
    runHeadless(h.clients, ["bundle", "build", proofBundle], h.io),
    0,
  );
  const [entry] = h.catalog.listEntries();
  h.catalog.grantTrust({
    operationId: "op-trust-1",
    digest: entry.digest,
    installationGeneration: entry.installationGeneration,
    grantedAt: new Date("2026-09-12T09:00:00.000Z"),
  });

  h.reset();
  assert.equal(runHeadless(h.clients, ["bundle", "list"], h.io), 0);
  assert.match(
    h.stdout(),
    /trust: trusted \(granted 2026-09-12T09:00:00\.000Z\)/,
  );

  h.reset();
  assert.equal(runHeadless(h.clients, ["bundle", "list", "--json"], h.io), 0);
  const snapshot = JSON.parse(h.stdout()) as {
    result: { bundles: { trust: { state: string; operationId?: string } }[] };
  };
  assert.deepEqual(snapshot.result.bundles[0].trust, {
    state: "trusted",
    operationId: "op-trust-1",
    grantedAt: "2026-09-12T09:00:00.000Z",
  });

  h.reset();
  assert.equal(
    runHeadless(
      h.clients,
      ["bundle", "inspect", "dev.secant.test-repair"],
      h.io,
    ),
    0,
  );
  assert.match(
    h.stdout(),
    /Trust: trusted \(granted 2026-09-12T09:00:00\.000Z\)/,
  );
});

test("bundle list with nothing installed says so", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["bundle", "list"], h.io), 0);
  assert.match(h.stdout(), /No Bundles are installed/);
});

test("bundle inspect shows the full focus and --json carries the bundle", async (t) => {
  const h = await harness(t);
  assert.equal(
    runHeadless(h.clients, ["bundle", "build", proofBundle], h.io),
    0,
  );

  h.reset();
  assert.equal(
    runHeadless(
      h.clients,
      ["bundle", "inspect", "dev.secant.test-repair"],
      h.io,
    ),
    0,
  );
  const text = h.stdout();
  assert.match(text, /Execution summary/);
  assert.match(text, /current user's authority/);
  assert.match(text, /Composition findings:/);
  assert.match(text, /none \(0 errors\)/);

  h.reset();
  assert.equal(
    runHeadless(
      h.clients,
      ["bundle", "inspect", "dev.secant.test-repair", "--json"],
      h.io,
    ),
    0,
  );
  const bundle = JSON.parse(h.stdout()) as {
    id: string;
    digest: string;
    platforms: string[];
    compositionFindings: unknown[];
  };
  assert.equal(bundle.id, "dev.secant.test-repair");
  assert.match(bundle.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(bundle.platforms, ["windows", "macos", "linux"]);
  assert.deepEqual(bundle.compositionFindings, []);
});

test("bundle inspect of an unknown id exits non-zero with a Problem", async (t) => {
  const h = await harness(t);
  assert.equal(
    runHeadless(h.clients, ["bundle", "inspect", "io.example.absent"], h.io),
    1,
  );
  assert.match(h.stderr(), /bundle-not-installed/);
  assert.equal(h.stdout(), "");
});

test("bundle inspect without an id exits non-zero", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["bundle", "inspect"], h.io), 1);
  assert.match(h.stderr(), /missing-bundle-id/);
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
