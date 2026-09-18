import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  createClaudeCodeAdapter,
} from "../../src/harness/harness.js";
import type {
  InterruptTurnOffer,
  ProjectionPort,
  RunView,
  SteerTurnOffer,
} from "../../src/application/projection-port.js";
import { installReplayer } from "../harness/replayer.js";
import { ensureRuntimeOnPath } from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";

// Interrupt a live Turn through the Port, resume the same Session, and reject the
// unavailable steer control (#118). Each test wires the Application against a
// recorded fixture replayer on a temporary configured `claude`, launches an Agent
// Bundle, and drives the Port. No real Harness runs (ADR 0027).

ensureRuntimeOnPath();

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

/** Author a single-Agent-step Bundle in Session `s`: the Turn the fixture drives. */
function writeAgentBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-interrupt-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "go.md"), "Do the work.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.interrupt-e2e",
      version: "1.0.0",
      name: "Interrupt E2E",
      description: "A single Agent Step Bundle for interrupt/resume.",
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

/** Wire the Application against the named fixture case as the configured Claude
 *  Code, minting the fixture's session id so its init acknowledges. Installs the
 *  single-Agent Bundle and approves the Workspace; returns the wired clients. */
function wire(
  t: TestContext,
  fixture: string,
  sessionId: string,
): { wired: Wiring; bundleId: string; digest: string } {
  const replayer = installReplayer(
    "2.1.273 (Claude Code)",
    fixtureCase(fixture),
  );
  const savedEnv = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  process.env[CLAUDE_CODE_EXECUTABLE_ENV] = replayer.executablePath;
  t.after(() => {
    if (savedEnv === undefined) delete process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    else process.env[CLAUDE_CODE_EXECUTABLE_ENV] = savedEnv;
  });

  const workspace = makeTempDir("secant-interrupt-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-interrupt-home-"),
    launchCwd: workspace,
    harnessAdapter: createClaudeCodeAdapter({ sessionId: () => sessionId }),
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

/** Poll the run Projection until a live Turn offers `interrupt-turn`, so a control
 *  is issued only once the Turn is admitted (await observable readiness, no sleep —
 *  admission pushes no durable update). Returns the live Turn's offer. */
async function awaitLiveTurn(
  port: ProjectionPort,
  runId: string,
): Promise<InterruptTurnOffer> {
  // The Turn admits out-of-process (prepare, spawn, init handshake), which takes
  // real wall time; poll on a short real interval up to a generous ceiling. This is
  // a bounded readiness condition, not a fixed sleep — it returns the instant the
  // live Turn's offer appears.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const opened = port.openProjection({ family: "run", runId });
    try {
      if (opened.snapshot.result.found) {
        const offer = opened.snapshot.result.run.actionOffers.find(
          (candidate): candidate is InterruptTurnOffer =>
            candidate.action === "interrupt-turn",
        );
        if (offer !== undefined) return offer;
      }
    } finally {
      opened.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the Agent Turn never went live");
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

// How the real Claude Code Adapter settles an interrupted live Turn on this OS. On
// Windows the process Module's graceful stage (`taskkill /T`, a close request to
// each window) cannot reach the hidden console replayer, so the kill escalates and
// the Adapter truthfully settles `lost` with interruption unknown (ADR 0022); the
// Run still rests `halted` with the Session detached, and resume still works.
const INTERRUPTED_KIND = process.platform === "win32" ? "lost" : "interrupted";

test("interrupt-turn stops a live Turn, rests the Run halted, detaches the Session, and settles the Turn interrupted (#118)", async (t) => {
  const { wired, digest } = wire(
    t,
    "interrupt",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
    },
  });
  assert.ok(launch.admitted, JSON.stringify(launch));
  const runId = launch.runId!;

  const offer = await awaitLiveTurn(port, runId);
  // A steer-turn offer stands beside it, marked unavailable with the exact reason.
  const steer = runView(port, runId).actionOffers.find(
    (candidate): candidate is SteerTurnOffer =>
      candidate.action === "steer-turn",
  );
  assert.ok(steer, "expected a steer-turn offer while the Turn is live");
  assert.equal(steer!.available, false);
  assert.equal(steer!.reason, "Claude Code has no same-Turn steer");

  const interrupt = port.submit({
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: offer.turnId },
  });
  assert.ok(interrupt.admitted);
  const interruptOutcome = await awaitSettled(port, "op-interrupt");
  assert.equal(
    interruptOutcome.status,
    "applied",
    JSON.stringify(interruptOutcome),
  );

  // The launch Operation settles once the interrupted Turn rests the Run halted.
  await awaitSettled(port, "op-launch");
  const run = runView(port, runId);
  assert.equal(run.state, "halted");
  assert.equal(run.sessions?.[0]?.session, "s");
  assert.equal(run.sessions?.[0]?.availability, "detached");
  const settled = run.timeline.find((event) => event.event === "turn-settled");
  assert.equal(settled?.detail, INTERRUPTED_KIND);

  // A control issued after acceptance is rejected as a value: the Turn has settled.
  const after = port.submit({
    operationId: "op-interrupt-again",
    operation: "interrupt-turn",
    input: { runId, turnId: offer.turnId },
  });
  assert.ok(after.admitted);
  const afterOutcome = await awaitSettled(port, "op-interrupt-again");
  assert.equal(afterOutcome.status, "not-applied");
  if (afterOutcome.status === "not-applied") {
    assert.equal(afterOutcome.problem.code, "turn-control-rejected");
  }
});

test("steer-turn is rejected as a value when submitted (#118)", async (t) => {
  const { wired, digest } = wire(
    t,
    "interrupt",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;
  const offer = await awaitLiveTurn(port, runId);

  const steer = port.submit({
    operationId: "op-steer",
    operation: "steer-turn",
    input: { runId, turnId: offer.turnId, text: "go faster" },
  });
  assert.ok(steer.admitted);
  const outcome = await awaitSettled(port, "op-steer");
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "steer-unavailable");
    assert.match(outcome.problem.explanation, /no same-Turn steer/);
  }

  // Interrupt so the Run rests and the wired process does not leak a live child.
  port.submit({
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: offer.turnId },
  });
  await awaitSettled(port, "op-launch");
});

test("resume-run continues a detached Session in the same Claude Code Session via --resume (#118)", async (t) => {
  const { wired, digest } = wire(
    t,
    "resume",
    "55555555-5555-4555-8555-555555555555",
  );
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;

  const offer = await awaitLiveTurn(port, runId);
  port.submit({
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: offer.turnId },
  });
  await awaitSettled(port, "op-launch");
  assert.equal(runView(port, runId).state, "halted");

  // Resume: the new process starts with --resume, init acknowledges the session, and
  // the Run continues in the same Session to its outcome.
  const resume = port.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  const resumeOutcome = await awaitSettled(port, "op-resume");
  assert.equal(resumeOutcome.status, "applied", JSON.stringify(resumeOutcome));
  assert.equal(runView(port, runId).state, "succeeded");
});

test("a signal (Ctrl+C) mid-Turn interrupts the Turn and rests the Run halted, not cancelled (#118, AC5)", async (t) => {
  // The headless OS-signal path (withClients) drives Application.shutdown(), which
  // aborts every live Run; a live Agent Turn interrupts at the Harness Seam and the
  // Run rests `halted` (resumable) — never `cancelled`. Exit-code (1 vs 130) is a
  // separate concern flagged as a spec conflict; the resting state is the AC value.
  const { wired, digest } = wire(
    t,
    "interrupt",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;
  await awaitLiveTurn(port, runId);

  await wired.shutdown();
  const run = runView(port, runId);
  assert.equal(run.state, "halted");
  const settled = run.timeline.find((event) => event.event === "turn-settled");
  assert.equal(settled?.detail, INTERRUPTED_KIND);
});

test("a resume the Harness does not acknowledge fails the Attempt and never creates a fresh Session (#118)", async (t) => {
  const { wired, digest } = wire(
    t,
    "resume-unacknowledged",
    "66666666-6666-4666-8666-666666666666",
  );
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;

  const offer = await awaitLiveTurn(port, runId);
  port.submit({
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: offer.turnId },
  });
  await awaitSettled(port, "op-launch");

  const resume = port.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted);
  await awaitSettled(port, "op-resume");
  const run = runView(port, runId);
  // The recovery failure rests the Run failed; the Session went unusable and no
  // fresh Session was ever opened in its place (ADR 0022).
  assert.equal(run.state, "failed");
  assert.equal(run.sessions?.[0]?.session, "s");
  assert.equal(run.sessions?.[0]?.availability, "unusable");
});
