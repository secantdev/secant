import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import { createCodexAdapter } from "../../src/harness/harness.js";
import type {
  ProjectionPort,
  RunView,
  SteerTurnOffer,
} from "../../src/application/projection-port.js";
import { installCodexReplayer } from "../harness/codex-replayer.js";
import { ensureRuntimeOnPath } from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";

// A selected Codex Run drives the same normalized client interactions as Claude
// Code — the timeline shapes, the durable snapshot, and the Turn-scoped controls —
// with only the Adapter changed (#148, spec stories 15–23). The one client-visible
// difference is a capability the profile declares: Codex offers native same-Turn
// Steer where Claude Code cannot. Each test wires the Application against a recorded
// Codex app-server replayer (no real Harness, ADR 0027) and drives the Port with
// `harness: "codex"`.

ensureRuntimeOnPath();

/** Author a single-Agent-step Bundle whose prompt renders to exactly `prompt` — the
 *  recorded fixture replays strictly, so the rendered Turn input must match byte for
 *  byte (readAgentPrompt returns the asset bytes verbatim). */
function writeAgentBundle(prompt: string): { folder: string; id: string } {
  const folder = makeTempDir("secant-codex-cli-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  // No trailing newline: the recorded turn/start input carries none.
  writeFileSync(join(folder, "prompts", "go.md"), prompt);
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.codex-cli-e2e",
      version: "1.0.0",
      name: "Codex Client E2E",
      description:
        "A single Agent Step Bundle driven through the Codex replayer.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/go.md", kind: "prompt" }],
    routing: [
      {
        id: "work",
        kind: "agent",
        session: "s",
        prompt: { asset: "prompts/go.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

/** Wire the Application with the Codex Adapter over the named recorded replayer, and
 *  a synthetic Codex discovery so Preflight admits the selection. Installs the
 *  single-Agent Bundle authored for `prompt` and approves the Workspace. */
function wire(
  t: TestContext,
  fixture: string,
  prompt: string,
): { wired: Wiring; bundleId: string; digest: string } {
  const replayer = installCodexReplayer(fixture);
  const workspace = makeTempDir("secant-codex-cli-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-codex-cli-home-"),
    launchCwd: workspace,
    codexHarnessAdapter: createCodexAdapter({ path: replayer.path, env: {} }),
    discoverCodex: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "codex",
        description: "PATH name 'codex'",
      },
    }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const bundle = writeAgentBundle(prompt);
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

function launchCodex(
  port: ProjectionPort,
  bundleId: string,
  digest: string,
): string {
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundleId },
      launchInputs: {},
      trustDigest: digest,
      harness: "codex",
    },
  });
  assert.ok(launch.admitted, JSON.stringify(launch));
  assert.ok(launch.runId);
  return launch.runId;
}

function runView(port: ProjectionPort, runId: string): RunView {
  const opened = port.openProjection({ family: "run", runId });
  try {
    assert.ok(opened.snapshot.result.found, JSON.stringify(opened.snapshot));
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    return opened.snapshot.result.run;
  } finally {
    opened.close();
  }
}

/** Poll the run Projection until a live Turn offers `steer-turn` available, so a
 *  control targets the current live generation (a Turn's durable admission pushes no
 *  durable update). Returns the available offer. */
async function awaitSteerable(
  port: ProjectionPort,
  runId: string,
): Promise<Extract<SteerTurnOffer, { available: true }>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = runView(port, runId);
    const steer = run.actionOffers.find(
      (offer): offer is SteerTurnOffer => offer.action === "steer-turn",
    );
    if (steer !== undefined && steer.available) return steer;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the Codex Agent Turn never offered an available steer");
}

test("[codex-shared-client-interactions] a live Codex Turn offers native Steer; steering keeps it working and the Run succeeds", async (t) => {
  const { wired, bundleId, digest } = wire(
    t,
    "steer",
    "Think silently about the number one until you receive more guidance. Do not inspect files or run tools.",
  );
  const port = wired.projectionPort;
  const runId = launchCodex(port, bundleId, digest);

  // The steer Offer is available (the Codex profile declares native steer), and it
  // carries the live turnId — no Claude-specific "unavailable" wording reaches the
  // client. Interrupt is offered beside it, as for any live Turn.
  const steer = await awaitSteerable(port, runId);
  assert.equal(steer.available, true);
  assert.match(steer.consequence, /without ending the Turn/);
  const interrupt = runView(port, runId).actionOffers.find(
    (offer) => offer.action === "interrupt-turn",
  );
  assert.ok(interrupt, "interrupt is offered beside steer on a live Turn");

  // Steering with the recorded guidance reaches the native Turn and is applied; the
  // Turn keeps working (steer never rests the Run) and then completes on its own.
  const steered = port.submit({
    operationId: "op-steer",
    operation: "steer-turn",
    input: {
      runId,
      turnId: steer.turnId,
      text: "Finish now with exactly: recorded steer.",
    },
  });
  assert.ok(steered.admitted);
  const steerOutcome = await awaitSettled(port, "op-steer");
  assert.equal(steerOutcome.status, "applied", JSON.stringify(steerOutcome));

  await awaitSettled(port, "op-launch");
  const run = runView(port, runId);
  assert.equal(run.state, "succeeded");
  // Codex activity normalizes into the same timeline vocabulary as Claude Code: a
  // Turn started and settled, with authoritative assistant content in between — no
  // protocol-specific frame kind crosses the Port (AC1/AC2).
  const kinds = run.timeline.map((event) => event.event);
  assert.ok(kinds.includes("turn-started"));
  assert.ok(kinds.includes("assistant-content"));
  assert.ok(kinds.includes("turn-settled"));
});

test("[codex-shared-client-interactions] a completed Codex Turn renders in existing timeline shapes and the Run succeeds", async (t) => {
  const { wired, bundleId, digest } = wire(
    t,
    "completion",
    "Reply with exactly: recorded completion.",
  );
  const port = wired.projectionPort;
  const runId = launchCodex(port, bundleId, digest);

  await awaitSettled(port, "op-launch");
  const run = runView(port, runId);
  assert.equal(run.state, "succeeded");
  // A Codex Session records its availability through the same normalized view.
  assert.equal(run.sessions?.[0]?.session, "s");
  // The effective model Codex actually supplied surfaces as evidence (never a picker
  // in M4); a native model object never crosses the Port.
  assert.ok(run.effectiveModel !== undefined);
  const settled = run.timeline.find((event) => event.event === "turn-settled");
  assert.equal(settled?.detail, "completed");
});
