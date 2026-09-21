import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import { createApplication, openRunGroup } from "../helpers/application.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  createClaudeCodeAdapter,
} from "../../src/harness/harness.js";
import type {
  ProjectionPort,
  ProjectionUpdate,
  RunLiveOverlay,
  RunSnapshot,
} from "../../src/application/projection-port.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { installReplayer } from "../harness/replayer.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { hostPlatform, writeCommandBundle } from "../helpers/commandBundle.js";

// #117 AC2: through the Port, the live overlay of a Run executing an Agent Turn
// shows the outstanding approval request with decisions `allow`/`deny` and a
// generation; answering with the current offer is accepted (the Operation is
// applied); answering with a stale generation or an expired id is rejected with the
// precise Problem; and the overlay clears the request when the Turn ends. Driven
// straight against the Projection Port (no headless follower) so the request stays
// outstanding to observe and answer by hand.

const TEST_REPAIR_SESSION_ID = "77777777-7777-4777-8777-777777777777";
const REPLAYER_VERSION = "2.1.273 (Claude Code)";

function fixtureCase(name: string): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "harness",
    "fixtures",
    "claude-code",
    name,
  );
}

function writeAgentBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-ovl-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "fix.md"), "Repair the workspace.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.ovl-e2e",
      version: "1.0.0",
      name: "Overlay E2E",
      description: "A single Agent Step Bundle for the live-overlay slice.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/fix.md", kind: "prompt" }],
    routing: [
      {
        id: "fix",
        kind: "agent",
        session: "s",
        prompt: { asset: "prompts/fix.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

function wire(t: TestContext): {
  wired: Wiring;
  bundleId: string;
  digest: string;
} {
  const replayer = installReplayer(
    REPLAYER_VERSION,
    fixtureCase("test-repair"),
  );
  const savedEnv = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  process.env[CLAUDE_CODE_EXECUTABLE_ENV] = replayer.executablePath;
  t.after(() => {
    if (savedEnv === undefined) delete process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    else process.env[CLAUDE_CODE_EXECUTABLE_ENV] = savedEnv;
  });

  const workspace = makeTempDir("secant-ovl-ws-");
  writeFileSync(
    join(workspace, "sum.mjs"),
    "export const sum = (a, b) => a - b;\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: workspace });

  const wired = wireApplication({
    secantHome: makeTempDir("secant-ovl-home-"),
    launchCwd: workspace,
    harnessAdapter: createClaudeCodeAdapter({
      sessionId: () => TEST_REPAIR_SESSION_ID,
    }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const bundle = writeAgentBundle();
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((e) => e.id === bundle.id);
  assert.ok(entry);
  const approve = wired.projectionPort.submit({
    operationId: "op-approve",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approve.admitted);
  return { wired, bundleId: bundle.id, digest: entry.digest };
}

/** Await the next live overlay on the stream that matches `predicate`. The Run's
 *  update stream is single-consumer, so these are called sequentially. */
async function nextOverlay(
  updates: AsyncIterable<ProjectionUpdate<RunSnapshot>>,
  predicate: (overlay: RunLiveOverlay) => boolean,
): Promise<RunLiveOverlay> {
  for await (const update of updates) {
    if (update.kind === "live" && predicate(update.overlay)) {
      return update.overlay;
    }
  }
  throw new Error("the run stream closed before a matching live overlay");
}

test("the live overlay shows the outstanding request; answering is accepted, stale/expired are rejected, and the overlay clears (#117 AC2)", async (t) => {
  const { wired, bundleId, digest } = wire(t);
  const port: ProjectionPort = wired.projectionPort;

  // Launch directly through the Port (no headless follower answers), so the Edit
  // approval stays outstanding for us to observe and answer by hand.
  const admission = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundleId },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId!;

  const opened = port.openProjection({ family: "run", runId });
  try {
    // The overlay carrying the outstanding approval, once the Turn raises it.
    const raised = await nextOverlay(
      opened.updates,
      (overlay) => overlay.outstanding.length > 0,
    );
    assert.equal(raised.outstanding.length, 1);
    const request = raised.outstanding[0]!;
    assert.equal(request.tool, "Edit");
    assert.deepEqual([...request.decisions], ["allow", "deny"]);
    assert.ok(raised.generation > 0);
    assert.equal(raised.phase, "awaiting-approval");
    // The answer Offer carries the live generation and names the ephemeral basis.
    assert.equal(raised.offers.length, 1);
    assert.equal(raised.offers[0]!.requestId, request.requestId);
    assert.equal(raised.offers[0]!.generation, raised.generation);
    assert.equal(raised.offers[0]!.basis, "ephemeral Harness Request");

    // An expired id (a request that is not outstanding) is rejected precisely,
    // answering nothing — the real request stays outstanding.
    const expired = port.submit({
      operationId: "op-expired",
      operation: "answer-harness-request",
      input: {
        runId,
        requestId: "not-a-real-request",
        generation: raised.generation,
        decision: "allow",
        by: "human",
      },
    });
    assert.ok(expired.admitted);
    const expiredOutcome = await awaitSettled(port, "op-expired");
    assert.equal(expiredOutcome.status, "not-applied");
    if (expiredOutcome.status === "not-applied") {
      assert.equal(expiredOutcome.problem.code, "harness-request-expired");
    }

    // A stale generation (the real request, an older generation) is rejected
    // precisely, answering nothing.
    const stale = port.submit({
      operationId: "op-stale",
      operation: "answer-harness-request",
      input: {
        runId,
        requestId: request.requestId,
        generation: raised.generation + 1,
        decision: "allow",
        by: "human",
      },
    });
    assert.ok(stale.admitted);
    const staleOutcome = await awaitSettled(port, "op-stale");
    assert.equal(staleOutcome.status, "not-applied");
    if (staleOutcome.status === "not-applied") {
      assert.equal(staleOutcome.problem.code, "harness-request-stale");
    }

    // Answering with the current offer is accepted (the Operation is applied) and
    // unblocks the Turn.
    const answer = port.submit({
      operationId: "op-answer",
      operation: "answer-harness-request",
      input: {
        runId,
        requestId: request.requestId,
        generation: raised.generation,
        decision: "allow",
        by: "human",
      },
    });
    assert.ok(answer.admitted);
    const answerOutcome = await awaitSettled(port, "op-answer");
    assert.equal(
      answerOutcome.status,
      "applied",
      JSON.stringify(answerOutcome),
    );

    // The overlay clears the request when the Turn moves on (a later generation).
    const cleared = await nextOverlay(
      opened.updates,
      (overlay) => overlay.outstanding.length === 0,
    );
    assert.ok(cleared.generation > raised.generation);
  } finally {
    opened.close();
  }

  // The launch settles once the answered Turn runs to completion.
  const outcome = await awaitSettled(port, "op-launch");
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  const final = port.openProjection({ family: "run", runId });
  try {
    assert.ok(final.snapshot.result.found);
    if (final.snapshot.result.found) {
      assert.equal(final.snapshot.result.run.state, "succeeded");
    }
  } finally {
    final.close();
  }
});

test("an indeterminate request-answer receipt settles not-applied with unknown effects (#134 A20)", async (t) => {
  const catalog = openCatalog(makeTempDir("secant-indeterminate-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(
    makeTempDir("secant-indeterminate-workspace-"),
  );
  const runGroup = openRunGroup(
    makeTempDir("secant-indeterminate-store-"),
    workspace,
  );
  t.after(() => runGroup.close());
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution: async ({ owner, requestChannel }) => {
      owner.writeState("running");
      assert.ok(requestChannel);
      requestChannel.bindAnswer(async () => ({ outcome: "indeterminate" }));
      requestChannel.raised({
        requestId: "request-unknown",
        tool: "Edit",
        input: "change file",
        decisions: ["allow", "deny"],
      });
      await finished;
      requestChannel.settled("request-unknown");
      requestChannel.bindAnswer(undefined);
      owner.writeState("succeeded");
      return { outcome: "succeeded" };
    },
  });
  const bundle = writeCommandBundle({ id: "dev.secant.indeterminate" });
  assert.ok(app.bundleManagement.build(bundle.folder, { noInstall: false }).ok);
  const entry = catalog.listEntries().find((item) => item.id === bundle.id)!;
  catalog.approveWorkspace(workspace, new Date());
  const launched = app.projectionPort.submit({
    operationId: "launch-indeterminate",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(launched.admitted, JSON.stringify(launched));

  const opened = app.projectionPort.openProjection({
    family: "run",
    runId: launched.runId!,
  });
  const raised = await nextOverlay(
    opened.updates,
    (overlay) => overlay.outstanding.length === 1,
  );
  const answer = app.projectionPort.submit({
    operationId: "answer-indeterminate",
    operation: "answer-harness-request",
    input: {
      runId: launched.runId!,
      requestId: "request-unknown",
      generation: raised.generation,
      decision: "allow",
      by: "human",
    },
  });
  assert.ok(answer.admitted);
  const outcome = await awaitSettled(app.projectionPort, answer.operationId);
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "harness-request-indeterminate");
    assert.equal(outcome.problem.possibleEffects, "unknown");
    assert.match(
      outcome.problem.remediation,
      /may or may not have been answered/,
    );
  }

  finish();
  await awaitSettled(app.projectionPort, launched.operationId);
  opened.close();
});
