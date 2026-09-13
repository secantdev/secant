import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  CommandParams,
  CommandStep,
  Platform,
  ProducedArtifact,
  RoutingNode,
} from "../../../src/workflow/workflow.js";
import { executeRouting } from "../../../src/run/execution/execution.js";
import { openRunGroup, type RunGroup } from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";

// #88: an Artifact declared `home: workspace` is materialized into the Workspace
// at its declared relative path, then verified byte-for-byte against the bound
// version before a later Step uses it. A missing or changed copy rests the Run
// `halted` and records a conflict, without overwriting the Workspace or adopting
// its bytes (ADR 0023). These drive the real execution + Run Store against a real
// on-disk Workspace, and cover the write, the verify, the conflict, and resume.

const AT = new Date("2026-09-13T12:00:00.000Z");
const HOST: Platform = process.platform === "win32" ? "windows" : "linux";
const NODE = process.execPath;
const dec = (bytes?: Uint8Array): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

interface Harness {
  readonly group: RunGroup;
  readonly workspace: string;
  readonly runId: string;
}

function harness(t: TestContext): Harness {
  const home = makeTempDir("secant-materialize-home-");
  const workspace = makeTempDir("secant-materialize-ws-");
  const group = openRunGroup(home, workspace);
  t.after(() => group.close());
  const created = group.createRun({
    operationId: "op-1",
    bundleSnapshotDigest: "sha256:deadbeef",
    launch: {},
    at: AT,
  });
  assert.ok(created.outcome === "created");
  return { group, workspace, runId: created.runId };
}

const produces = (...decls: ProducedArtifact[]): ProducedArtifact[] => decls;

function commandStep(
  id: string,
  command: CommandParams,
  step: Partial<CommandStep> = {},
): CommandStep {
  return { id, kind: "command", command, ...step };
}

/** Run one Routing to rest against a fresh owner, closing it after. */
function drive(h: Harness, routing: RoutingNode[]): { outcome: string } {
  const owner = h.group.acquireRun(h.runId);
  assert.ok(owner);
  try {
    return executeRouting(routing, {
      owner,
      platform: HOST,
      resolveAsset: () => undefined,
      now: () => AT,
    });
  } finally {
    owner.close();
  }
}

function state(h: Harness): string {
  const read = h.group.readRun(h.runId);
  assert.ok(read.ok);
  return read.run.state;
}

function boundBytes(h: Harness, name: string): Uint8Array | undefined {
  const owner = h.group.acquireRun(h.runId);
  assert.ok(owner);
  try {
    const versionId = owner.currentVersion(name);
    return versionId === undefined
      ? undefined
      : owner.readArtifact(versionId, name);
  } finally {
    owner.close();
  }
}

/** The Steps this suite reuses: `produce` writes "hello-world" to `out/x.txt`;
 *  `consume` references `{artifact: x}` (so it verifies x before running). */
const produceStep = commandStep(
  "produce",
  {
    executable: NODE,
    arguments: ["-e", "process.stdout.write('hello-world')"],
  },
  {
    produces: produces({
      name: "x",
      type: "text",
      home: "workspace",
      path: "out/x.txt",
    }),
  },
);
const consumeStep = commandStep(
  "consume",
  {
    executable: NODE,
    arguments: ["-e", "process.stdout.write('used')", { artifact: "x" }],
  },
  { requires: ["x"], produces: produces({ name: "y", type: "text" }) },
);

/** A Command Step that rewrites the given absolute path with `content`. It
 *  declares a text output (the captured stdout) so it publishes a normal Attempt,
 *  like a real Command Step. */
function rewriteStep(
  id: string,
  absPath: string,
  content: string,
): CommandStep {
  const script = `require('node:fs').writeFileSync(${JSON.stringify(absPath)}, ${JSON.stringify(content)})`;
  return commandStep(
    id,
    { executable: NODE, arguments: ["-e", script] },
    { produces: produces({ name: `${id}-log`, type: "text" }) },
  );
}

/** A Command Step that deletes the given absolute path. */
function deleteStep(id: string, absPath: string): CommandStep {
  const script = `require('node:fs').rmSync(${JSON.stringify(absPath)})`;
  return commandStep(
    id,
    { executable: NODE, arguments: ["-e", script] },
    { produces: produces({ name: `${id}-log`, type: "text" }) },
  );
}

test("materializes a home:workspace output and a later Step uses it (AC1)", (t) => {
  const h = harness(t);
  const xPath = join(h.workspace, "out", "x.txt");

  const report = drive(h, [produceStep, consumeStep]);

  assert.deepEqual(report, { outcome: "succeeded" });
  assert.equal(state(h), "succeeded");
  // The file exists at the declared path with the exact bytes.
  assert.equal(readFileSync(xPath, "utf8"), "hello-world");
  // The store stays canonical: the binding is the produced version.
  assert.equal(dec(boundBytes(h, "x")), "hello-world");
  // The consuming Step ran and produced its own output.
  assert.equal(dec(boundBytes(h, "y")), "used");
});

test("modifying the file between Steps halts with a conflict, untouched (AC2)", (t) => {
  const h = harness(t);
  const xPath = join(h.workspace, "out", "x.txt");

  const report = drive(h, [
    produceStep,
    rewriteStep("tamper", xPath, "tampered!!"),
    consumeStep,
  ]);

  assert.deepEqual(report, { outcome: "halted" });
  assert.equal(state(h), "halted");
  // The modified file is left exactly as the tamper left it — never overwritten.
  assert.equal(readFileSync(xPath, "utf8"), "tampered!!");
  // The binding is unchanged (the Workspace bytes are never adopted).
  assert.equal(dec(boundBytes(h, "x")), "hello-world");
  // The consuming Step never ran, so it bound nothing.
  assert.equal(boundBytes(h, "y"), undefined);

  const owner = h.group.acquireRun(h.runId);
  assert.ok(owner);
  try {
    const conflicts = owner.materializationConflicts();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.artifactName, "x");
    assert.equal(conflicts[0]!.path, "out/x.txt");
    const diagnostic = dec(owner.readDiagnostic(conflicts[0]!.diagnosticId));
    assert.ok(diagnostic);
    assert.match(diagnostic, /out\/x\.txt/);
    assert.match(diagnostic, /changed/);
  } finally {
    owner.close();
  }
});

test("deleting the file between Steps halts with a conflict (AC3)", (t) => {
  const h = harness(t);
  const xPath = join(h.workspace, "out", "x.txt");

  const report = drive(h, [
    produceStep,
    deleteStep("remove", xPath),
    consumeStep,
  ]);

  assert.deepEqual(report, { outcome: "halted" });
  assert.equal(state(h), "halted");
  // Still absent — the store never re-materializes on a conflict.
  assert.ok(!existsSync(xPath));
  assert.equal(dec(boundBytes(h, "x")), "hello-world");

  const owner = h.group.acquireRun(h.runId);
  assert.ok(owner);
  try {
    const [conflict] = owner.materializationConflicts();
    assert.ok(conflict);
    const diagnostic = dec(owner.readDiagnostic(conflict.diagnosticId));
    assert.ok(diagnostic);
    assert.match(diagnostic, /missing/);
  } finally {
    owner.close();
  }
});

test("restoring the file and resuming continues the Run (AC2/AC3)", (t) => {
  const h = harness(t);
  const xPath = join(h.workspace, "out", "x.txt");
  const routing = [
    produceStep,
    rewriteStep("tamper", xPath, "tampered!!"),
    consumeStep,
  ];

  assert.deepEqual(drive(h, routing), { outcome: "halted" });

  // The user restores the file to its bound content, then resumes.
  writeFileSync(xPath, "hello-world");
  const claim = h.group.resumeRun(h.runId);
  assert.equal(claim.outcome, "resumed");

  const report = drive(h, routing);
  assert.deepEqual(report, { outcome: "succeeded" });
  assert.equal(state(h), "succeeded");
  // The consuming Step ran on resume; the completed Steps were not re-run (the
  // tamper Step did not re-tamper), so the restored file survived.
  assert.equal(dec(boundBytes(h, "y")), "used");
  assert.equal(readFileSync(xPath, "utf8"), "hello-world");
});

test("byte comparison is exact — a changed line ending is a conflict (AC4)", (t) => {
  const h = harness(t);
  const xPath = join(h.workspace, "crlf.txt");
  const produceCrlf = commandStep(
    "produce",
    { executable: NODE, arguments: ["-e", "process.stdout.write('a\\r\\nb')"] },
    {
      produces: produces({
        name: "x",
        type: "text",
        home: "workspace",
        path: "crlf.txt",
      }),
    },
  );

  // Materialized exactly, CRLF preserved.
  assert.deepEqual(drive(h, [produceCrlf]), { outcome: "succeeded" });
  assert.deepEqual([...readFileSync(xPath)], [...Buffer.from("a\r\nb")]);

  // Rewriting only the line ending (LF) must still be a conflict — no
  // normalization treats "a\nb" as equal to the bound "a\r\nb".
  const report = drive(h, [
    produceCrlf,
    rewriteStep("normalize", xPath, "a\nb"),
    consumeStep,
  ]);
  assert.deepEqual(report, { outcome: "halted" });
  assert.equal(state(h), "halted");
});
