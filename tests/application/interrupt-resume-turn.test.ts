import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type {
  HarnessAdapter,
  HarnessProfile,
  TurnResult,
} from "../../src/harness/harness.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import type {
  InterruptTurnOffer,
  ProjectionPort,
  RunView,
  SteerTurnOffer,
} from "../../src/application/projection-port.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";

// Interrupt a live Turn through the Port, resume the same Session, and reject the
// unavailable steer control (#118). Each test wires the Application against the
// deterministic fake Claude Code Harness (native steer unavailable) and an injected
// fake Process — no child spawns (#184). No real Harness runs (ADR 0027).

// Claude Code's stream-json print mode has no same-Turn guidance frame, so the steer
// Offer is unavailable and its `reason` is exactly this profile evidence.
const STEER_EVIDENCE =
  "Claude Code's stream-json print mode has no same-Turn guidance frame: a further user message queues as the next Turn, so steer is rejected unsupported and never emulated.";

/** The fake Claude Code profile: native reattach recovery, process-only interruption,
 *  and — the fact these cases turn on — steer unavailable, carrying the exact evidence
 *  the steer Offer and the steer-unavailable Problem surface. */
function claudeProfile(): HarnessProfile {
  return {
    harness: "Claude Code",
    executable: "claude",
    executableVersion: "2.1.273",
    platform: "linux",
    adapterRevision: "fake-claude-1",
    configurationPosture: "user-compatible",
    recovery: {
      mode: "native-reattach",
      evidence: "fake claude resumes by id",
    },
    interruption: {
      mode: "process-only",
      evidence: "fake claude stops the process",
    },
    approvals: {
      available: true,
      evidence: "fake claude hosts a permission bridge",
    },
    clarifications: {
      available: false,
      evidence: "fake claude offers no clarifications",
    },
    steer: { available: false, evidence: STEER_EVIDENCE },
    modelSelection: {
      at: "unavailable",
      evidence: "fake claude selects no model",
    },
    modelObservation: {
      available: true,
      evidence: "fake claude observes its own model",
    },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "fake claude mints a session id",
    },
    skillDelivery: {
      mode: "plain-path",
      evidence: "fake claude reads a SKILL.md path",
    },
    fileDelivery: {
      mode: "plain-path",
      evidence: "fake claude reads an absolute path",
    },
  };
}

// A live Turn interrupted cleanly settles `interrupted` on every OS: the fake Harness
// has no hidden-console child to force-kill, so the Windows force-kill→`lost` variant
// (ADR 0022) is a real-child artifact covered by the runtime replayer conformance, not
// this in-process semantic suite. The interrupted Turn detaches Session "s" by its
// recovery coordinate so a resume can reattach it.
const INTERRUPTED_DETACHED: TurnResult = {
  kind: "interrupted",
  detail: {
    interruption: {
      mode: "process-only",
      evidence: "fake claude stops the process",
    },
    session: { state: "detached", coordinate: { opaque: "s" } },
  },
};

const COMPLETED_OPEN: TurnResult = {
  kind: "completed",
  detail: {
    finalContent: "done",
    effectiveModel: { known: false },
    session: { state: "open" },
  },
};

// A resume the Harness does not acknowledge: the recovery phase fails and the Session
// becomes permanently unusable, so no fresh Session is ever opened in its place.
const FAILED_UNACKNOWLEDGED: TurnResult = {
  kind: "failed",
  detail: {
    failure: {
      phase: "recovery",
      category: "recovery-unacknowledged",
      possibleEffects: "possible",
      diagnostics: "the resumed Session was not acknowledged",
    },
    effectiveModel: { known: false },
    session: {
      state: "unusable",
      reason: "the resumed Session was not acknowledged",
    },
  },
};

/** A Turn that emits a Session event then blocks until it is interrupted (or the
 *  Harness is closed); an interrupt settles it `interrupted` with Session "s"
 *  detached — the request-free "blocks mid-Turn" shape the interrupt cases drive. */
function blockingTurn(): FakeScript["turns"][number] {
  return {
    events: [{ kind: "session", availability: { state: "open" } }],
    block: true,
    result: COMPLETED_OPEN, // unused: the Turn is interrupted, never settling naturally
    interruptResult: INTERRUPTED_DETACHED,
  };
}

/** A Turn that completes straight away, reattaching the resumed Session. */
function completedTurn(): FakeScript["turns"][number] {
  return {
    events: [
      { kind: "session", availability: { state: "open" } },
      { kind: "assistant-content", content: "resumed and finished" },
    ],
    result: COMPLETED_OPEN,
  };
}

/** A Turn whose recovery is unacknowledged, failing the resumed Attempt. */
function unacknowledgedTurn(): FakeScript["turns"][number] {
  return { result: FAILED_UNACKNOWLEDGED };
}

/** The scripts one wiring hands out, one per Harness preparation. A launch prepares
 *  once; a resume prepares a fresh Harness, so the second script drives the resumed
 *  Turn. Extra preparations reuse the last script. */
function scriptsFor(scenario: string): readonly FakeScript[] {
  const blocking: FakeScript = {
    profile: claudeProfile(),
    turns: [blockingTurn()],
  };
  if (scenario === "resume") {
    return [blocking, { profile: claudeProfile(), turns: [completedTurn()] }];
  }
  if (scenario === "resume-unacknowledged") {
    return [
      blocking,
      { profile: claudeProfile(), turns: [unacknowledgedTurn()] },
    ];
  }
  return [blocking];
}

/** A Harness Adapter that prepares one scripted fake Harness per `prepare` call. The
 *  Application re-prepares a fresh Harness for each execution (launch, then resume), so
 *  a scenario's successive Turn behaviours are keyed to the preparation sequence. */
function sequencedAdapter(scripts: readonly FakeScript[]): HarnessAdapter {
  let index = 0;
  return {
    prepare(options) {
      const script = scripts[Math.min(index, scripts.length - 1)]!;
      index += 1;
      return createFake(script)().prepare(options);
    },
  };
}

/** A fake Process that resolves any executable and reaches no real child; Git store
 *  operations run through the deterministic fake Git process. */
function fakeProcess(): ProcessAdapter {
  const git = createFakeGitProcess();
  const commands = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: () => ({
      kind: "exited",
      status: 0,
      text: new Uint8Array(),
    }),
  });
  return {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => git.spawnCommandSync(options),
  };
}

/** Author a single-Agent-step Bundle in Session `s`: the Turn the fake drives. */
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

/** Wire the Application against the fake Claude Code Harness for `scenario` and an
 *  injected fake Process. Installs the single-Agent Bundle and approves the Workspace;
 *  returns the wired clients. */
function wire(
  t: TestContext,
  scenario: string,
): { wired: Wiring; bundleId: string; digest: string } {
  const workspace = makeTempDir("secant-interrupt-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-interrupt-home-"),
    launchCwd: workspace,
    process: fakeProcess(),
    harnessAdapter: sequencedAdapter(scriptsFor(scenario)),
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "claude",
        description: "PATH name 'claude'",
      },
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

/** Poll the run Projection until a live Turn offers `interrupt-turn`, so a control
 *  is issued only once the Turn is admitted (await observable readiness, no sleep —
 *  admission pushes no durable update). Returns the live Turn's offer. */
async function awaitLiveTurn(
  port: ProjectionPort,
  runId: string,
): Promise<InterruptTurnOffer> {
  // The Turn admits asynchronously (prepare, the driver's first microtasks), so poll
  // on a short real interval up to a generous ceiling. This is a bounded readiness
  // condition, not a fixed sleep — it returns the instant the live Turn's offer appears.
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

test("interrupt-turn stops a live Turn, rests the Run halted, detaches the Session, and settles the Turn interrupted (#118)", async (t) => {
  const { wired, digest } = wire(t, "interrupt");
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
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
  assert.equal(steer!.reason, STEER_EVIDENCE);

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
  assert.equal(settled?.detail, "interrupted");

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
  const { wired, digest } = wire(t, "interrupt");
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
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
    assert.match(outcome.problem.explanation, /stream-json print mode/);
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
  const { wired, digest } = wire(t, "resume");
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
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
  const { wired, digest } = wire(t, "interrupt");
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;
  await awaitLiveTurn(port, runId);

  await wired.shutdown();
  const run = runView(port, runId);
  assert.equal(run.state, "halted");
  const settled = run.timeline.find((event) => event.event === "turn-settled");
  assert.equal(settled?.detail, "interrupted");
});

test("a resume the Harness does not acknowledge fails the Attempt and never creates a fresh Session (#118)", async (t) => {
  const { wired, digest } = wire(t, "resume-unacknowledged");
  const port = wired.projectionPort;
  const launch = port.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.interrupt-e2e" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
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
