import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type Application,
  type RunExecution,
} from "../../src/application/application.js";
import { buildBundle, writeZip } from "../../src/bundle/bundle.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { openRunGroup, type RunGroup } from "../../src/run/store/store.js";
import {
  ensureRuntimeOnPath,
  hostPlatform,
  writeCommandBundle,
  type CommandBundleOptions,
} from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { readArchiveEntries } from "../helpers/zip.js";
import {
  bareRepo,
  classicWorktree,
  linkedWorktree,
  plainDirectory,
  unbornWorktree,
} from "../helpers/gitWorktree.js";

// Preflight is exercised through the Application's Projection Port — the Module's
// public Interface — never by importing the private submodule (the boundary suite
// forbids it). Each failure asserts the Problem and that no Run and no Trust grant
// were left behind; the real Git worktree and PATH probes run over real temporary
// resources (testing.md).

ensureRuntimeOnPath();

// The real Run execution, only reached when Preflight passes (the git pass cases
// stop at the Trust gate rather than running).
const runExecution: RunExecution = ({ routing, owner }) =>
  executeRouting(routing, {
    owner,
    platform: hostPlatform(),
    resolveAsset: () => undefined,
  });

interface Fixture {
  readonly app: Application;
  readonly catalog: Catalog;
  readonly runGroup: RunGroup;
  readonly workspace: string;
}

// A fixture whose launch Workspace is the given path (a real Git worktree, or a
// plain/bare directory), approved so the launch reaches Preflight.
function fixture(t: TestContext, workspace: string): Fixture {
  const catalog = openCatalog(makeTempDir("secant-pf-home-"));
  t.after(() => catalog.close());
  const runGroup = openRunGroup(makeTempDir("secant-pf-store-"), workspace);
  t.after(() => runGroup.close());
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution,
  });
  catalog.approveWorkspace(workspace, new Date());
  return { app, catalog, runGroup, workspace };
}

function install(
  f: Fixture,
  options?: CommandBundleOptions,
): { id: string; digest: string } {
  const cmd = writeCommandBundle(options);
  const built = f.app.bundleManagement.build(cmd.folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((e) => e.id === cmd.id);
  assert.ok(entry);
  return { id: cmd.id, digest: entry.digest };
}

function launch(
  f: Fixture,
  id: string,
  extra: {
    trustDigest?: string;
    launchInputs?: Record<string, string>;
  } = {},
) {
  return f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: {
      bundle: { id },
      launchInputs: extra.launchInputs ?? {},
      ...(extra.trustDigest !== undefined
        ? { trustDigest: extra.trustDigest }
        : {}),
    },
  });
}

// --- git-worktree-root probe ----------------------------------------------

for (const [label, make] of [
  ["a subdirectory of a worktree", subdirectoryOfWorktree],
  ["a bare repository", bareRepo],
  ["a plain directory", plainDirectory],
] as const) {
  test(`launching from ${label} fails git-worktree-root, no Run and no grant`, (t) => {
    const f = fixture(t, make());
    const { id, digest } = install(f, { prerequisites: ["git-worktree-root"] });

    const admission = launch(f, id, { trustDigest: digest });
    assert.equal(admission.admitted, false);
    if (admission.admitted) throw new Error("unreachable");
    assert.equal(admission.problem.code, "workspace-prerequisite-failed");
    assert.equal(admission.problem.details?.prerequisite, "git-worktree-root");
    // A failed Preflight leaves no Run and no Trust grant.
    assert.deepEqual(f.runGroup.listRuns(), []);
    assert.equal(f.catalog.getTrustGrant(digest, 1), undefined);
  });
}

for (const [label, make] of [
  ["a classic worktree root", classicWorktree],
  ["a linked worktree root", linkedWorktree],
  ["an unborn worktree root", unbornWorktree],
] as const) {
  test(`launching from ${label} passes git-worktree-root`, (t) => {
    const f = fixture(t, make());
    const { id } = install(f, { prerequisites: ["git-worktree-root"] });

    // No trust acknowledgement: Preflight passes the git probe (and the PATH
    // check), so the launch reaches the Trust gate rather than a Preflight
    // Problem — proof the worktree qualifies.
    const admission = launch(f, id);
    assert.equal(admission.admitted, false);
    if (admission.admitted) throw new Error("unreachable");
    assert.equal(admission.problem.code, "bundle-trust-required");
  });
}

test("Git absent from PATH names Git as not runnable, no Run", (t) => {
  const f = fixture(t, classicWorktree());
  const { id, digest } = install(f, { prerequisites: ["git-worktree-root"] });

  const savedPath = process.env.PATH;
  try {
    // Strip PATH so the git probe cannot resolve `git`. Restored at once; submit
    // is synchronous, so no other test observes the change.
    process.env.PATH = "";
    const admission = launch(f, id, { trustDigest: digest });
    assert.equal(admission.admitted, false);
    if (admission.admitted) throw new Error("unreachable");
    assert.equal(admission.problem.code, "workspace-prerequisite-failed");
    assert.match(admission.problem.explanation, /not runnable/);
    assert.deepEqual(f.runGroup.listRuns(), []);
  } finally {
    process.env.PATH = savedPath;
  }
});

// --- command executable resolution ----------------------------------------

test("a Command whose executable is not on PATH is refused, no Run", (t) => {
  const f = fixture(t, plainDirectory());
  const { id, digest } = install(f, {
    executable: "secant-no-such-binary-xyz",
  });

  const admission = launch(f, id, { trustDigest: digest });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "command-executable-not-found");
  assert.equal(admission.problem.details?.step, "run-check");
  assert.equal(
    admission.problem.details?.executable,
    "secant-no-such-binary-xyz",
  );
  assert.deepEqual(f.runGroup.listRuns(), []);
});

// --- Launch input validation ----------------------------------------------

test("missing or type-invalid Launch inputs yield one field violation per input, no Run", (t) => {
  const dir = makeTempDir("secant-pf-inputs-");
  const empty = join(dir, "empty.txt");
  writeFileSync(empty, "");
  const f = fixture(t, plainDirectory());
  const { id, digest } = install(f, {
    inputs: {
      note: { type: "text", description: "a note" },
      report: { type: "file", description: "a file" },
      docs: { type: "file-set", description: "a file-set" },
      decision: { type: "verdict", description: "a verdict" },
      pick: { type: "choice", description: "a choice", choices: ["a", "b"] },
    },
  });

  const admission = launch(f, id, {
    trustDigest: digest,
    launchInputs: {
      // `note` omitted entirely → required-but-missing
      report: empty, // exists but empty → invalid file
      docs: "", // empty collection
      decision: "maybe", // not pass/fail
      pick: "c", // not a declared choice
    },
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "launch-input-invalid");
  const fields = (admission.problem.fieldViolations ?? []).map((v) => v.field);
  assert.equal(fields.length, 5);
  assert.deepEqual(
    new Set(fields),
    new Set(["note", "report", "docs", "decision", "pick"]),
  );
  assert.deepEqual(f.runGroup.listRuns(), []);
});

test("valid Launch inputs of every type pin to the created Run and are visible in run show", (t) => {
  const dir = makeTempDir("secant-pf-valid-");
  const fileA = join(dir, "a.txt");
  writeFileSync(fileA, "a\n");
  const fileB = join(dir, "b.txt");
  writeFileSync(fileB, "b\n");
  const f = fixture(t, plainDirectory());
  const { id, digest } = install(f, {
    inputs: {
      note: { type: "text", description: "a note" },
      report: { type: "file", description: "a file" },
      docs: { type: "file-set", description: "a file-set" },
      decision: { type: "verdict", description: "a verdict" },
      pick: { type: "choice", description: "a choice", choices: ["a", "b"] },
    },
  });

  const inputs = {
    note: "hello",
    report: fileA,
    docs: `${fileA}\n${fileB}`,
    decision: "pass",
    pick: "a",
  };
  const admission = launch(f, id, {
    trustDigest: digest,
    launchInputs: inputs,
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const record = f.runGroup.readRun(admission.runId!);
  assert.ok(record.ok);
  if (record.ok) assert.deepEqual(record.run.launch, inputs);
});

// --- Composition re-check (corrupted pinned Snapshot) ----------------------

test("a Snapshot failing the Composition re-check is refused as corrupted, no Run", (t) => {
  const f = fixture(t, plainDirectory());

  // Build a valid command Bundle, then repack it with a manifest that is shape-
  // valid but no longer composes (a Step requires an artifact nothing binds), and
  // install those bytes directly. This is the corrupted-pinned-Snapshot case the
  // launch-time re-check exists for (a build never emits such bytes).
  const cmd = writeCommandBundle();
  const built = buildBundle(cmd.folder);
  assert.ok(built.ok, JSON.stringify(built));
  const entries = readArchiveEntries(built.built.bytes);
  const manifestEntry = entries.find((e) => e.path === "manifest.json");
  assert.ok(manifestEntry, "archive has a manifest.json");
  const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  manifest.routing[0].requires = ["ghost-artifact"]; // unbound → composition error
  const corruptBytes = writeZip(
    entries.map((e) =>
      e.path === "manifest.json"
        ? { path: e.path, data: Buffer.from(JSON.stringify(manifest)) }
        : { path: e.path, data: e.data },
    ),
  );
  const digest = createHash("sha256").update(corruptBytes).digest("hex");
  const result = f.catalog.installBundle({
    identity: { id: manifest.bundle.id, version: manifest.bundle.version },
    digest,
    bytes: corruptBytes,
    origin: { kind: "local-file", path: "corrupt.wfb" },
    installedAt: new Date(),
  });
  assert.equal(result.outcome, "installed");

  const admission = launch(f, manifest.bundle.id);
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "bundle-snapshot-corrupt");
  assert.match(admission.problem.remediation, /[Rr]einstall/);
  // No routing vocabulary leaks into the Problem the user sees.
  const shown = `${admission.problem.explanation} ${admission.problem.remediation}`;
  assert.doesNotMatch(shown, /ghost-artifact|unbound|run-check|artifact/);
  assert.deepEqual(f.runGroup.listRuns(), []);
});

// --- intrinsic Step-kind precondition (the Proof Bundle) -------------------

test("the Proof Bundle (Agent Step) is refused with the Step-kind Problem, no Run", (t) => {
  const f = fixture(t, plainDirectory());
  const proofFolder = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "bundles",
    "test-repair-workflow",
  );
  const built = f.app.bundleManagement.build(proofFolder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog
    .listEntries()
    .find((e) => e.id === "dev.secant.test-repair")!;

  // Even without the Bundle's required `failing-test` input, the Step-kind
  // failure is reported first — the Routing cannot run at all in this release.
  const admission = launch(f, entry.id, { trustDigest: entry.digest });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "step-kind-not-executable");
  // The first non-executable Step in routing order is the Agent step `fix`.
  assert.equal(admission.problem.details?.step, "fix");
  assert.equal(admission.problem.details?.kind, "agent");
  assert.match(admission.problem.remediation, /interactive|terminal/i);
  assert.deepEqual(f.runGroup.listRuns(), []);
});

// --- helpers ---------------------------------------------------------------

function subdirectoryOfWorktree(): string {
  const root = classicWorktree();
  const sub = join(root, "nested");
  mkdirSync(sub);
  return realpathSync.native(sub);
}
