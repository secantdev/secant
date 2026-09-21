import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type Application,
  type RunExecution,
} from "../../src/application/application.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import type { ProcessAdapter, SpawnResult } from "../../src/process/process.js";
import type { RunGroup, RunOwner } from "../../src/run/store/store.js";
import { hostPlatform, writeCommandBundle } from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import {
  createFakeGitProcess,
  openFakeRunGroup as openRunGroup,
} from "../run/store/fake-git-process.js";

// The Command steps' execution runs through an injected fake Process, so no child
// is spawned. These tests inject their own `runExecution`, so the fake command is
// never reached — but the Application requires a Process (it reaches Preflight),
// so this fake stands in for the real one and never spawns.
function fakeCommand(): SpawnResult {
  return { kind: "exited", status: 0, text: new Uint8Array() };
}

const executionProcess: ProcessAdapter = (() => {
  const git = createFakeGitProcess();
  const commands = createFakeProcess({
    resolutionHandler: (name) =>
      name === "secant-no-such-binary-xyz"
        ? { kind: "not-found" }
        : { kind: "found", executable: name, prefixArgs: [] },
    commandHandler: fakeCommand,
  });
  return {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => git.spawnCommandSync(options),
  };
})();

interface Fixture {
  readonly app: Application;
  readonly catalog: Catalog;
  readonly held: (() => void | Promise<void>)[];
  readonly closes: number[];
  readonly id: string;
  readonly digest: string;
}

function fixture(
  t: TestContext,
  runExecution: RunExecution,
  releaseError: Error,
  deferSettlement = true,
): Fixture {
  const catalog = openCatalog(makeTempDir("secant-settlement-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(
    makeTempDir("secant-settlement-workspace-"),
  );
  const realGroup = openRunGroup(
    makeTempDir("secant-settlement-store-"),
    workspace,
  );
  t.after(() => realGroup.close());
  const closes: number[] = [];
  const runGroup = {
    ...realGroup,
    acquireRun(runId, options) {
      const owner = realGroup.acquireRun(runId, options);
      if (owner === undefined) return undefined;
      return {
        ...owner,
        release(): ReturnType<RunOwner["release"]> {
          throw releaseError;
        },
        close(): void {
          closes.push(closes.length + 1);
          owner.close();
        },
      };
    },
  } satisfies RunGroup;
  const held: (() => void | Promise<void>)[] = [];
  const app = createApplication({
    catalog,
    process: executionProcess,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution,
    scheduleSettlement: deferSettlement
      ? (settle) => {
          held.push(settle);
        }
      : (settle) => settle(),
  });
  const bundle = writeCommandBundle({ id: "dev.secant.settlement" });
  const built = app.bundleManagement.build(bundle.folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = catalog.listEntries().find((item) => item.id === bundle.id)!;
  catalog.approveWorkspace(workspace, new Date());
  return { app, catalog, held, closes, id: bundle.id, digest: entry.digest };
}

function launch(f: Fixture, operationId: string) {
  const admission = f.app.projectionPort.submit({
    operationId,
    operation: "launch-run",
    input: {
      bundle: { id: f.id },
      launchInputs: {},
      trustDigest: f.digest,
    },
  });
  assert.ok(admission.admitted);
  return admission;
}

test("a synchronously throwing settler records a normalized execution fault without escaping submit", (t) => {
  const catalog = openCatalog(makeTempDir("secant-sync-settlement-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(
    makeTempDir("secant-sync-settlement-workspace-"),
  );
  const throwingCatalog = {
    ...catalog,
    approveWorkspace(): never {
      throw new Error("approval write threw");
    },
  } satisfies Catalog;
  const app = createApplication({
    catalog: throwingCatalog,
    process: executionProcess,
    launchWorkspacePath: workspace,
  });

  assert.doesNotThrow(() => {
    const admission = app.projectionPort.submit({
      operationId: "approve-throwing",
      operation: "approve-workspace",
      input: { path: workspace },
    });
    assert.ok(admission.admitted);
  });
  const opened = app.projectionPort.openProjection({
    family: "operation",
    operationId: "approve-throwing",
  });
  const outcome = opened.snapshot.outcome;
  opened.close();
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "run-execution-fault");
    assert.equal(outcome.problem.possibleEffects, "unknown");
  }
});

test("a release rejection records a normalized execution fault and still closes the owner", async (t) => {
  const f = fixture(
    t,
    async () => ({ outcome: "blocked" }),
    new Error("release threw"),
    false,
  );
  const launched = launch(f, "launch-blocked");
  assert.deepEqual(
    await awaitSettled(f.app.projectionPort, launched.operationId),
    { status: "applied" },
  );

  let cancelOperationId: string | undefined;
  assert.doesNotThrow(() => {
    const cancel = f.app.projectionPort.submit({
      operationId: "cancel-blocked",
      operation: "cancel-run",
      input: { runId: launched.runId! },
    });
    assert.ok(cancel.admitted);
    cancelOperationId = cancel.operationId;
  });
  assert.ok(cancelOperationId);
  const outcome = await awaitSettled(f.app.projectionPort, cancelOperationId);
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "run-execution-fault");
    assert.equal(outcome.problem.possibleEffects, "unknown");
  }
  assert.equal(f.closes.length, 1);
});

test("a rejecting settler records a normalized execution fault", async (t) => {
  const f = fixture(
    t,
    async () => ({ outcome: "succeeded" }),
    new Error("release rejected"),
  );
  const launched = launch(f, "launch-rejecting");
  let unhandled: unknown;
  const onUnhandled = (error: unknown): void => {
    unhandled = error;
  };
  process.once("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  await assert.doesNotReject(async () => {
    await f.held.shift()?.();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(unhandled, undefined);
  const outcome = await awaitSettled(
    f.app.projectionPort,
    launched.operationId,
  );
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "run-execution-fault");
    assert.equal(outcome.problem.possibleEffects, "unknown");
  }
  assert.equal(f.closes.length, 1);
});
