import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createApplication } from "../helpers/application.js";
import { type HeadlessIO, runHeadless } from "../../src/headless/headless.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { buildBundle } from "../../src/bundle/bundle.js";
import { openHeadlessHarness } from "../helpers/headlessHarness.js";
import { makeTempDir } from "../helpers/tempDir.js";
import type { HarnessProfile } from "../../src/harness/harness.js";

// This suite exercises Bundle and Workspace commands only, so it wires no Run
// Store or execution.
function harness(t: TestContext) {
  return openHeadlessHarness(t, {
    slug: "secant-headless",
    runSupport: false,
  });
}

const HEADLESS_HARNESS_PROFILE: HarnessProfile = {
  harness: "Codex",
  executable: "PATH name 'codex' -> /tools/codex",
  executableVersion: "1.2.3",
  platform: "linux",
  adapterRevision: "headless-test-v1",
  configurationPosture: "Uses the user's existing Codex configuration.",
  recovery: { mode: "native-reattach", evidence: "Native resume." },
  interruption: { mode: "active-turn", evidence: "Native interrupt." },
  approvals: { available: true, evidence: "Native approvals." },
  clarifications: { available: true, evidence: "Native questions." },
  steer: { available: true, evidence: "Native steering." },
  modelSelection: {
    at: "launch",
    declaration: { kind: "list", models: ["gpt-5", "gpt-5-mini"] },
    evidence: "Observed models.",
  },
  modelObservation: { available: true, evidence: "Model events." },
  recoveryCoordinate: {
    timing: "before-submission",
    evidence: "Known before content.",
  },
  skillDelivery: { mode: "plain-path", evidence: "Path delivery." },
  fileDelivery: { mode: "plain-path", evidence: "Path delivery." },
};

function harnessCatalog(t: TestContext) {
  let qualificationCalls = 0;
  const opened = openHeadlessHarness(t, {
    slug: "secant-headless-harness-catalog",
    runSupport: false,
    now: () => new Date("2026-09-22T00:00:00.000Z"),
    harnessRegistry: [
      {
        choice: { id: "codex", name: "Codex", availability: "available" },
        servedCapabilities: ["agent-turn", "interactive-turns"],
        discover: () => ({
          kind: "found",
          source: "path",
          description: "PATH name 'codex'",
        }),
        qualify: async () => {
          qualificationCalls++;
          return { ok: true, profile: HEADLESS_HARNESS_PROFILE };
        },
      },
    ],
  });
  return { ...opened, qualificationCalls: () => qualificationCalls };
}

test("approve then show --json reports approved with the canonical path", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["workspace", "approve"], h.io), 0);

  h.reset();
  assert.equal(await runHeadless(h.clients, ["workspace", "--json"], h.io), 0);
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
    startupNotices: [],
    harnesses: [],
    actionOffers: [],
  });
});

test("show on an unapproved workspace names the approve command", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["workspace"], h.io), 0);
  const text = h.stdout();
  assert.match(text, /unapproved/);
  assert.match(text, /secant workspace approve/);
});

test("approve --json prints the operation result verbatim", async (t) => {
  const h = await harness(t);
  assert.equal(
    await runHeadless(h.clients, ["workspace", "approve", "--json"], h.io),
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
    await runHeadless(h.clients, ["workspace", "approve", missing], h.io),
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

  assert.equal(
    await runHeadless(clients, ["workspace", "approve", "sub"], io),
    0,
  );

  out.length = 0;
  assert.equal(await runHeadless(clients, ["workspace", "--json"], io), 0);
  const snapshot = JSON.parse(out.join("")) as {
    approval: { state: string };
  };
  assert.equal(snapshot.approval.state, "approved");
});

test("an unknown command exits non-zero with guidance", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["bundle", "frobnicate"], h.io), 1);
  assert.match(h.stderr(), /unknown-command/);
});

test("an unknown top-level command exits non-zero", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["frobnicate"], h.io), 1);
  assert.match(h.stderr(), /unknown-command/);
});

test("an unknown flag exits non-zero", async (t) => {
  const h = await harness(t);
  assert.equal(
    await runHeadless(h.clients, ["bundle", "list", "--bogus"], h.io),
    1,
  );
  assert.match(h.stderr(), /unknown-option/);
});

test("--help lists every command, including bundle install, and exits zero", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["--help"], h.io), 0);
  const text = h.stdout();
  assert.match(text, /Usage: secant/);
  for (const command of [
    "workspace",
    "workspace approve",
    "bundle list",
    "bundle inspect",
    "bundle build",
    "bundle install",
    "harness list",
    "harness inspect",
  ]) {
    assert.match(text, new RegExp(command.replace(/ /g, "\\s")));
  }
  assert.equal(h.stderr(), "");
});

test("harness list text and JSON discover without qualification", async (t) => {
  const h = harnessCatalog(t);
  assert.equal(await h.run(["harness", "list"]), 0);
  assert.match(h.stdout(), /Codex/);
  assert.match(h.stdout(), /Discovery: found via PATH name 'codex'/);
  assert.match(h.stdout(), /Qualification: not checked/);
  assert.equal(h.qualificationCalls(), 0);

  h.reset();
  assert.equal(await h.run(["harness", "list", "--json"]), 0);
  assert.deepEqual(JSON.parse(h.stdout()), {
    family: "harness-catalog",
    view: "list",
    harnesses: [
      {
        id: "codex",
        name: "Codex",
        discovery: {
          state: "found",
          source: "path",
          description: "PATH name 'codex'",
        },
        qualification: { state: "not-checked" },
      },
    ],
  });
  assert.equal(h.qualificationCalls(), 0);
});

test("harness inspect awaits qualification and freezes text and inner JSON", async (t) => {
  const h = harnessCatalog(t);
  assert.equal(await h.run(["harness", "inspect", "codex"]), 0);
  const text = h.stdout();
  assert.match(text, /^Codex \(codex\)$/m);
  assert.match(text, /Qualification: qualified/);
  assert.match(text, /Supported models: gpt-5, gpt-5-mini/);
  assert.match(text, /Session recovery: Available/);
  assert.match(
    text,
    /Configuration: Uses the user's existing Codex configuration/,
  );
  assert.equal(h.qualificationCalls(), 1);

  h.reset();
  assert.equal(await h.run(["harness", "inspect", "codex", "--json"]), 0);
  assert.deepEqual(JSON.parse(h.stdout()), {
    id: "codex",
    name: "Codex",
    discovery: {
      state: "found",
      source: "path",
      description: "PATH name 'codex'",
    },
    qualification: {
      state: "qualified",
      observation: {
        executable: "PATH name 'codex' -> /tools/codex",
        executableVersion: "1.2.3",
        platform: "linux",
        checkedAt: "2026-09-22T00:00:00.000Z",
      },
    },
    supportedModels: { kind: "list", models: ["gpt-5", "gpt-5-mini"] },
    capabilities: [
      {
        capability: "session-recovery",
        name: "Session recovery",
        description: "Resume a Harness Session after process loss.",
        state: "available",
      },
      {
        capability: "same-turn-steering",
        name: "Same-Turn steering",
        description: "Send guidance while the current Turn is still working.",
        state: "available",
      },
      {
        capability: "turn-interruption",
        name: "Turn interruption",
        description: "Stop the current Turn and its native work.",
        state: "available",
      },
      {
        capability: "tool-approvals",
        name: "Tool approvals",
        description: "Review tool actions raised by the Harness.",
        state: "available",
      },
      {
        capability: "structured-questions",
        name: "Structured questions",
        description: "Answer structured questions raised by the Harness.",
        state: "available",
      },
      {
        capability: "effective-model",
        name: "Effective model",
        description: "Observe the model that actually served a Turn.",
        state: "available",
      },
    ],
    configurationPosture: "Uses the user's existing Codex configuration.",
  });
  assert.equal(h.qualificationCalls(), 1);
});

test("harness inspect refuses a missing or unknown semantic id", async (t) => {
  const h = harnessCatalog(t);
  assert.equal(await h.run(["harness", "inspect"]), 1);
  assert.match(h.stderr(), /missing-harness-id/);

  h.reset();
  assert.equal(await h.run(["harness", "inspect", "gemini"]), 1);
  assert.match(h.stderr(), /harness-not-found/);
  assert.equal(h.qualificationCalls(), 0);

  h.reset();
  assert.equal(await h.run(["harness", "inspect", "--json"]), 1);
  assert.deepEqual(JSON.parse(h.stdout()), {
    code: "missing-harness-id",
    explanation: "harness inspect needs a Harness id.",
    remediation: "Run `secant harness inspect <id>`.",
    possibleEffects: "none",
  });

  h.reset();
  assert.equal(await h.run(["harness", "inspect", "gemini", "--json"]), 1);
  assert.deepEqual(JSON.parse(h.stdout()), {
    code: "harness-not-found",
    explanation: "Harness 'gemini' is not registered in this Secant build.",
    remediation: "Run `secant harness list` to see the registered Harnesses.",
    possibleEffects: "none",
    details: { harnessId: "gemini" },
  });
});

test("harness inspect renders a registered authentication refusal as inspectable state", async (t) => {
  const h = openHeadlessHarness(t, {
    slug: "secant-headless-harness-auth",
    runSupport: false,
    harnessRegistry: [
      {
        choice: { id: "codex", name: "Codex", availability: "available" },
        servedCapabilities: ["agent-turn", "interactive-turns"],
        discover: () => ({
          kind: "found",
          source: "path",
          description: "PATH name 'codex'",
        }),
        qualify: async () => ({
          ok: false,
          failure: {
            phase: "prepare",
            category: "authentication",
            possibleEffects: "none",
            diagnostics: "Login is required.",
          },
        }),
      },
    ],
  });

  assert.equal(await h.run(["harness", "inspect", "codex"]), 0);
  assert.match(h.stdout(), /Qualification: not ready/);
  assert.match(h.stdout(), /Authentication: Log in separately through Codex/);
  assert.match(h.stdout(), /Remediation: Log in separately through Codex/);
  assert.match(h.stdout(), /Diagnostic: harness-diagnostic:codex:/);
  assert.equal(h.stderr(), "");
});

test("run resume help exposes the explicit takeover flag", async (t) => {
  const h = await harness(t);
  assert.equal(
    await runHeadless(h.clients, ["run", "resume", "--help"], h.io),
    0,
  );
  assert.match(h.stdout(), /--takeover/);
});

test("a subcommand's --help prints that subcommand and exits zero", async (t) => {
  const h = await harness(t);
  assert.equal(
    await runHeadless(h.clients, ["bundle", "inspect", "--help"], h.io),
    0,
  );
  assert.match(h.stdout(), /secant bundle inspect/);
  assert.match(h.stdout(), /id@version/);
});

test("--version prints the embedded version and exits zero", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["--version"], h.io), 0);
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
    await runHeadless(
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
    await runHeadless(
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
    await runHeadless(
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
    await runHeadless(
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
    await runHeadless(h.clients, ["bundle", "build", proofBundle], h.io),
    0,
  );
  assert.match(h.stdout(), /Bundle: dev\.secant\.test-repair@1\.0\.0/);
  assert.match(h.stdout(), /^Installed\.$/m);

  h.reset();
  assert.equal(await runHeadless(h.clients, ["workspace", "--json"], h.io), 0);
  const snapshot = JSON.parse(h.stdout()) as { installedBundleCount: number };
  assert.equal(snapshot.installedBundleCount, 1);
});

test("bundle build prints the advisory findings in plain text on the success path (A12)", async (t) => {
  const h = await harness(t);
  assert.equal(
    await runHeadless(h.clients, ["bundle", "build", proofBundle], h.io),
    0,
  );
  // The derived-engine finding is always present on a successful build; it was
  // dropped from the plain-text report before A12 (only `--json` carried it).
  assert.match(h.stdout(), /^Findings:$/m);
  assert.match(h.stdout(), /Derived requires\.engine/);
});

test("bundle list shows the installed row and --json carries the snapshot", async (t) => {
  const h = await harness(t);
  assert.equal(
    await runHeadless(h.clients, ["bundle", "build", proofBundle], h.io),
    0,
  );

  h.reset();
  assert.equal(await runHeadless(h.clients, ["bundle", "list"], h.io), 0);
  const text = h.stdout();
  assert.match(text, /dev\.secant\.test-repair@1\.0\.0/);
  assert.match(text, /digest: sha256:[0-9a-f]{64}/);
  assert.match(text, /platforms: windows, macos, linux/);
  assert.match(text, /not yet trusted/);

  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["bundle", "list", "--json"], h.io),
    0,
  );
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
    await runHeadless(h.clients, ["bundle", "build", proofBundle], h.io),
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
  assert.equal(await runHeadless(h.clients, ["bundle", "list"], h.io), 0);
  assert.match(
    h.stdout(),
    /trust: trusted \(granted 2026-09-12T09:00:00\.000Z\)/,
  );

  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["bundle", "list", "--json"], h.io),
    0,
  );
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
    await runHeadless(
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

test("bundle list and inspect name a built-in's Secant release and app-release trust", async (t) => {
  const h = await harness(t);
  const built = buildBundle(proofBundle);
  assert.ok(built.ok);
  const file = join(makeTempDir("secant-headless-shipped-"), "proof.wfb");
  writeFileSync(file, built.built.bytes);
  assert.deepEqual(h.clients.ensureShippedBundles([file]), []);

  assert.equal(await runHeadless(h.clients, ["bundle", "list"], h.io), 0);
  assert.match(
    h.stdout(),
    /origin: Built-in, shipped with Secant 0\.0\.0-dev · in this release/,
  );
  assert.match(h.stdout(), /trust: trusted \(app release\)/);

  h.reset();
  assert.equal(
    await runHeadless(
      h.clients,
      ["bundle", "inspect", "dev.secant.test-repair", "--json"],
      h.io,
    ),
    0,
  );
  const focus = JSON.parse(h.stdout()) as Record<string, unknown>;
  assert.deepEqual(focus.origin, {
    kind: "built-in",
    secantVersion: "0.0.0-dev",
  });
  assert.equal(focus.shippedWithRunningSecant, true);
  assert.deepEqual(focus.trust, { state: "app-release" });
});

test("startup notices reach stderr before the command and leave its --json intact", async (t) => {
  const h = await harness(t);
  const clients = {
    ...h.clients,
    startupNotices: [
      {
        code: "shipped-bundle-not-installed",
        explanation: "Secant could not install its built-in Bundle x.wfb.",
        remediation: "Point SECANT_HOME at a fresh home.",
        possibleEffects: "none" as const,
      },
    ],
  };
  assert.equal(
    await runHeadless(clients, ["bundle", "list", "--json"], h.io),
    0,
  );
  assert.match(
    h.stderr(),
    /^Notice \[shipped-bundle-not-installed\]: Secant could not install its built-in Bundle x\.wfb\.\nRemediation: Point SECANT_HOME at a fresh home\.\n$/,
  );
  assert.equal(JSON.parse(h.stdout()).family, "bundle-catalog");
});

test("bundle list with nothing installed says so", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["bundle", "list"], h.io), 0);
  assert.match(h.stdout(), /No Bundles are installed/);
});

test("bundle inspect shows the full focus and --json carries the bundle", async (t) => {
  const h = await harness(t);
  assert.equal(
    await runHeadless(h.clients, ["bundle", "build", proofBundle], h.io),
    0,
  );

  h.reset();
  assert.equal(
    await runHeadless(
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
    await runHeadless(
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
    await runHeadless(
      h.clients,
      ["bundle", "inspect", "io.example.absent"],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /bundle-not-installed/);
  assert.equal(h.stdout(), "");
});

test("bundle inspect without an id exits non-zero", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["bundle", "inspect"], h.io), 1);
  assert.match(h.stderr(), /missing-bundle-id/);
});

test("bundle install of the built file reports already installed", async (t) => {
  const h = await harness(t);
  const output = join(makeTempDir("secant-headless-wfb-"), "out.wfb");
  assert.equal(
    await runHeadless(
      h.clients,
      ["bundle", "build", proofBundle, "--output", output],
      h.io,
    ),
    0,
  );
  assert.ok(existsSync(output));

  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["bundle", "install", output], h.io),
    0,
  );
  assert.match(h.stdout(), /Already installed/);
});
