import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import type {
  ActionOffer,
  RunView,
} from "../../src/application/projection-port.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

// The first Interactive agent Step end to end (#122): a synthesized Bundle
// `interactive-agent (session "s") -> agent (session "s")` launched through the
// composition wiring against the deterministic fake Adapter with the TUI's
// `supportsInteractiveTurns`. The Run rests `blocked` at the interactive Step; each
// `send-interactive-turn` is one human Turn whose verbatim text is the transcript
// input; `end-interactive-step` settles the Step and the following Agent Step reuses
// the Session. Headless still refuses such a Bundle at Preflight (that stays in
// preflight.test.ts); this suite drives the whole Interactive path.

function profile(): HarnessProfile {
  return {
    harness: "Claude Code",
    executable: "fake-claude",
    executableVersion: "0.0.0-fake",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "process-only", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    clarifications: { available: false, evidence: "scripted fake" },
    steer: { available: false, evidence: "scripted fake" },
    modelSelection: { at: "unavailable", evidence: "scripted fake" },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "scripted fake",
    },
    skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
    fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
  };
}

/** One scripted Turn that completes and leaves the Session detached, so the next
 *  human Turn (and the following Agent Step) resumes the same Session. Every Turn
 *  the fake serves in this suite reuses it: a fresh prepared Harness per human Turn
 *  replays the same script entry, which is exactly the detached-resume path. */
const COMPLETED_DETACHED: FakeScript["turns"][number] = {
  result: {
    kind: "completed",
    detail: {
      finalContent: "acknowledged",
      effectiveModel: { known: true, model: "fake-sonnet" },
      session: { state: "detached", coordinate: { opaque: "coord-s" } },
    },
  },
};

/** Author an `interactive-agent (session "s") -> agent (session "s")` Bundle. */
function writeInteractiveBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-interactive-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "discuss.md"), "Discuss the plan.\n");
  writeFileSync(join(folder, "prompts", "apply.md"), "Apply the plan.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.interactive-e2e",
      version: "1.0.0",
      name: "Interactive E2E",
      description: "An interactive-agent -> agent Bundle for the first Step.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [
      { path: "prompts/discuss.md", kind: "prompt" },
      { path: "prompts/apply.md", kind: "prompt" },
    ],
    routing: [
      {
        id: "discuss",
        kind: "interactive-agent",
        session: "s",
        prompt: { asset: "prompts/discuss.md" },
      },
      {
        id: "apply",
        kind: "agent",
        session: "s",
        prompt: { asset: "prompts/apply.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

/** Wire the Application against a temporary home and the fake Adapter with the TUI's
 *  interactive-turn support, install the Bundle, approve the Workspace, and launch
 *  the Run to its first `blocked` rest at the interactive Step. */
async function launchInteractive(
  t: TestContext,
  script: FakeScript,
  counts?: { prepares: number; readonly closes: number[] },
): Promise<{ wired: Wiring; runId: string; run: RunView }> {
  const savedExecutable = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  // A resolvable executable so Preflight's Harness discovery passes; the fake
  // Adapter is what actually runs, never this path.
  process.env[CLAUDE_CODE_EXECUTABLE_ENV] = process.execPath;
  t.after(() => {
    if (savedExecutable === undefined)
      delete process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    else process.env[CLAUDE_CODE_EXECUTABLE_ENV] = savedExecutable;
  });

  const workspace = makeTempDir("secant-interactive-ws-");
  const fake = createFake(script)();
  const adapter: HarnessAdapter =
    counts === undefined
      ? fake
      : {
          async prepare(options) {
            counts.prepares += 1;
            const index = counts.closes.push(0) - 1;
            const prepared = await fake.prepare(options);
            if (!prepared.ok) return prepared;
            const harness = prepared.harness;
            return {
              ok: true,
              harness: {
                profile: harness.profile,
                startTurn: (request) => harness.startTurn(request),
                async close() {
                  counts.closes[index] = counts.closes[index]! + 1;
                  return harness.close();
                },
              },
            };
          },
        };
  const wired = wireApplication({
    secantHome: makeTempDir("secant-interactive-home-"),
    launchCwd: workspace,
    supportsInteractiveTurns: true,
    harnessAdapter: adapter,
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const bundle = writeInteractiveBundle();
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((e) => e.id === bundle.id);
  assert.ok(entry);

  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");
  return { wired, runId, run: readRun(wired, runId) };
}

/** Read the current `run` snapshot. */
function readRun(wired: Wiring, runId: string): RunView {
  const opened = wired.projectionPort.openProjection({ family: "run", runId });
  try {
    assert.ok(opened.snapshot.result.found, JSON.stringify(opened.snapshot));
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    return opened.snapshot.result.run;
  } finally {
    opened.close();
  }
}

function offer<A extends ActionOffer["action"]>(
  run: RunView,
  action: A,
): Extract<ActionOffer, { action: A }> | undefined {
  return run.actionOffers.find((o) => o.action === action) as
    Extract<ActionOffer, { action: A }> | undefined;
}

async function send(
  wired: Wiring,
  runId: string,
  operationId: string,
  stepId: string,
  text: string,
): Promise<void> {
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "send-interactive-turn",
    input: { runId, stepId, text },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const outcome = await awaitSettled(wired.projectionPort, operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
}

async function awaitInterruptOffer(wired: Wiring, runId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const interrupt = offer(readRun(wired, runId), "interrupt-turn");
    if (interrupt !== undefined) return interrupt;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the interactive Turn never exposed its interrupt Offer");
}

test("interactive-agent rests blocked, takes two human Turns, and ends into the same Session (#122)", async (t) => {
  const counts = { prepares: 0, closes: [] as number[] };
  const { wired, runId, run } = await launchInteractive(
    t,
    {
      profile: profile(),
      turns: [COMPLETED_DETACHED, COMPLETED_DETACHED, COMPLETED_DETACHED],
    },
    counts,
  );

  // Rests `blocked` at the interactive Step with the "interactive Turn" basis, and
  // offers exactly send + end at the boundary; no Attempt has settled yet.
  assert.equal(run.state, "blocked");
  assert.equal(run.progress[run.position]?.kind, "interactive-agent");
  const sendOffer = offer(run, "send-interactive-turn");
  assert.ok(sendOffer, JSON.stringify(run.actionOffers));
  assert.equal(sendOffer.basis, "interactive Turn");
  assert.ok(offer(run, "end-interactive-step"));
  assert.equal(run.turnPosition, undefined);

  // Two human Turns: each is one Turn whose verbatim text is the transcript input.
  await send(wired, runId, "op-t1", "discuss", "let us start here");
  const afterOne = readRun(wired, runId);
  assert.equal(afterOne.state, "blocked");
  assert.equal(afterOne.turnPosition, 1);

  await send(wired, runId, "op-t2", "discuss", "now the next idea");
  assert.equal(counts.prepares, 1);
  assert.deepEqual(counts.closes, [0]);
  const afterTwo = readRun(wired, runId);
  assert.equal(afterTwo.turnPosition, 2);
  const transcriptReference = afterTwo.sessions?.[0]?.transcriptPage;
  assert.ok(transcriptReference);
  const transcript = wired.projectionPort.readTranscript(transcriptReference);
  assert.ok(transcript.found);
  if (!transcript.found) throw new Error("unreachable");
  const humanInputs = transcript.entries
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content);
  assert.deepEqual(humanInputs, ["let us start here", "now the next idea"]);
  // The Session detached after each human Turn, so the next Turn resumes it.
  assert.equal(afterTwo.sessions?.length, 1);
  assert.equal(afterTwo.sessions?.[0]?.session, "s");
  assert.equal(afterTwo.sessions?.[0]?.availability, "detached");
  // #124: a detached Session that recorded human Turns still advertises its
  // transcript page/export References.
  assert.equal(afterTwo.sessions?.[0]?.transcriptPage?.type, "transcript-page");
  assert.equal(
    afterTwo.sessions?.[0]?.transcriptExport?.type,
    "transcript-export",
  );

  // End the Step at a boundary: it settles succeeded and the Agent Step reuses "s".
  const end = wired.projectionPort.submit({
    operationId: "op-end",
    operation: "end-interactive-step",
    input: { runId, stepId: "discuss" },
  });
  assert.ok(end.admitted, JSON.stringify(end));
  const endOutcome = await awaitSettled(wired.projectionPort, "op-end");
  assert.equal(endOutcome.status, "applied", JSON.stringify(endOutcome));
  assert.equal(counts.prepares, 2);
  assert.deepEqual(counts.closes, [1, 1]);

  const done = readRun(wired, runId);
  assert.equal(done.state, "succeeded");
  assert.deepEqual(
    done.progress.map((s) => s.status),
    ["succeeded", "succeeded"],
  );

  // The human Turns are origin `human`; the autonomous Agent Turn is `managed`. The
  // Run has rested, so acquiring the owner here fences nothing live. The Crucible
  // Turn kind is recorded independently (#126): the two Interactive Turns and the
  // following Agent Turn are distinguished even though they share one Session.
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    const origins = owner.turns().map((turn) => turn.origin);
    assert.deepEqual(origins, ["human", "human", "managed"]);
    const kinds = owner.turns().map((turn) => turn.kind);
    assert.deepEqual(kinds, [
      "interactive-agent",
      "interactive-agent",
      "agent",
    ]);
  } finally {
    owner.close();
  }

  // After settlement and reopen, the projected durable timeline distinguishes the
  // same historical Turn kinds in the same order — both clients read them off the
  // `turn-started` entries, never from `progress[position]` (#126).
  const timelineKinds = done.timeline
    .filter((event) => event.event === "turn-started")
    .map((event) => event.turnKind);
  assert.deepEqual(timelineKinds, [
    "interactive-agent",
    "interactive-agent",
    "agent",
  ]);
  assert.ok(
    done.timeline.some((event) => event.event === "interactive-step-ended"),
    JSON.stringify(done.timeline),
  );

  // The headless client reads the same reopened history: `run show` prints each
  // historical Turn kind in the same order (AC4), the Interactive Turns before the
  // Agent Turn.
  const shown = await runShow(wired, runId);
  const firstInteractive = shown.indexOf("turn-started interactive-agent");
  const firstAgent = shown.indexOf("turn-started agent");
  assert.ok(firstInteractive >= 0, shown);
  assert.ok(firstAgent > firstInteractive, shown);
  assert.match(shown, /interactive-step-ended/);
});

test("run show names the interactive Turn basis for a blocked interactive Step (#122, A15)", async (t) => {
  // The interactive Turn is the second of the three blocked bases `run show` must name
  // (durable Human Gate, interactive Turn, ephemeral Harness Request). It comes off the
  // durable send-interactive-turn Offer, so `run show` prints it from the snapshot alone.
  const { wired, runId, run } = await launchInteractive(t, {
    profile: profile(),
    turns: [COMPLETED_DETACHED],
  });
  assert.equal(run.state, "blocked");
  const shown = await runShow(wired, runId);
  assert.match(shown, /Blocked: interactive Turn/);
});

/** Render the headless `run show` for a Run through the public headless entrypoint,
 *  so this reads the reopened history exactly as the CLI client does. */
async function runShow(wired: Wiring, runId: string): Promise<string> {
  const out: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: () => {},
    cwd: () => process.cwd(),
  };
  const code = await runHeadless(
    {
      projectionPort: wired.projectionPort,
      bundleManagement: wired.bundleManagement,
    },
    ["run", "show", runId],
    io,
  );
  assert.equal(code, 0);
  return out.join("");
}

test("a blank interactive Turn is refused before any stdin is sent (#122)", async (t) => {
  const { wired, runId } = await launchInteractive(t, {
    profile: profile(),
    turns: [COMPLETED_DETACHED],
  });

  const admission = wired.projectionPort.submit({
    operationId: "op-blank",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "   \n\t " },
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "interactive-turn-blank");

  // No Turn was admitted: the Run is still at its first blocked rest.
  const run = readRun(wired, runId);
  assert.equal(run.state, "blocked");
  assert.equal(run.turnPosition, undefined);
});

test("shutdown closes the Step-scoped Harness once and leaves the interactive rest blocked (#134 A17/A21)", async (t) => {
  const counts = { prepares: 0, closes: [] as number[] };
  const { wired, runId } = await launchInteractive(
    t,
    { profile: profile(), turns: [COMPLETED_DETACHED] },
    counts,
  );
  assert.equal(counts.prepares, 1);
  assert.deepEqual(counts.closes, [0]);

  await wired.shutdown();

  assert.deepEqual(counts.closes, [1]);
  assert.equal(readRun(wired, runId).state, "blocked");
  assert.equal(
    wired.runGroup.listRuns().find((run) => run.runId === runId)?.live,
    false,
  );
});

test("interrupt closes the Step-scoped Harness after one qualification (#134 A17)", async (t) => {
  const counts = { prepares: 0, closes: [] as number[] };
  const { wired, runId } = await launchInteractive(
    t,
    {
      profile: profile(),
      turns: [
        {
          block: true,
          result: {
            kind: "completed",
            detail: {
              finalContent: "unused",
              effectiveModel: { known: false },
              session: {
                state: "detached",
                coordinate: { opaque: "coord-s" },
              },
            },
          },
        },
      ],
    },
    counts,
  );
  const sent = wired.projectionPort.submit({
    operationId: "op-send-interrupted",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "stop this Turn" },
  });
  assert.ok(sent.admitted);
  const interruptOffer = await awaitInterruptOffer(wired, runId);
  const interrupted = wired.projectionPort.submit({
    operationId: "op-interrupt-interactive",
    operation: "interrupt-turn",
    input: { runId, turnId: interruptOffer.turnId },
  });
  assert.ok(interrupted.admitted);
  assert.equal(
    (await awaitSettled(wired.projectionPort, interrupted.operationId)).status,
    "applied",
  );
  await awaitSettled(wired.projectionPort, sent.operationId);

  assert.equal(readRun(wired, runId).state, "halted");
  assert.equal(counts.prepares, 1);
  assert.deepEqual(counts.closes, [1]);
});

test("end-interactive-step mid-Turn is rejected with a precise Problem (#122)", async (t) => {
  // A Turn that blocks after admission until it is interrupted or the Harness closes,
  // so a real "mid-Turn" window exists to submit End Step into.
  const counts = { prepares: 0, closes: [] as number[] };
  const { wired, runId } = await launchInteractive(
    t,
    {
      profile: profile(),
      turns: [
        {
          block: true,
          result: {
            kind: "completed",
            detail: {
              finalContent: "unused",
              effectiveModel: { known: false },
              session: {
                state: "detached",
                coordinate: { opaque: "coord-s" },
              },
            },
          },
        },
      ],
    },
    counts,
  );

  // Start a human Turn but do not await it — it blocks mid-Turn.
  const sendAdmission = wired.projectionPort.submit({
    operationId: "op-send",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "thinking out loud" },
  });
  assert.ok(sendAdmission.admitted, JSON.stringify(sendAdmission));

  // A live human Turn runs under `running`, not `blocked`, so a crash mid-Turn
  // reconciles through the #118 path instead of stranding the Run (#122).
  assert.equal(readRun(wired, runId).state, "running");

  // End Step while the Turn is live is refused precisely, changing nothing.
  const endAdmission = wired.projectionPort.submit({
    operationId: "op-end",
    operation: "end-interactive-step",
    input: { runId, stepId: "discuss" },
  });
  assert.ok(endAdmission.admitted, JSON.stringify(endAdmission));
  const endOutcome = await awaitSettled(wired.projectionPort, "op-end");
  assert.equal(endOutcome.status, "not-applied");
  if (endOutcome.status !== "not-applied") throw new Error("unreachable");
  assert.equal(endOutcome.problem.code, "interactive-step-mid-turn");

  // Cancel resolves against the *live* Turn (the refused End must not have clobbered
  // its settling promise): the cancel and the send both settle, and the Run rests
  // exactly `cancelled` once the real Turn has unwound.
  const cancel = wired.projectionPort.submit({
    operationId: "op-cancel",
    operation: "cancel-run",
    input: { runId },
  });
  assert.ok(cancel.admitted, JSON.stringify(cancel));
  const cancelOutcome = await awaitSettled(wired.projectionPort, "op-cancel");
  assert.equal(cancelOutcome.status, "applied", JSON.stringify(cancelOutcome));
  await awaitSettled(wired.projectionPort, "op-send");
  assert.equal(readRun(wired, runId).state, "cancelled");
  assert.equal(counts.prepares, 1);
  assert.deepEqual(counts.closes, [1]);
});
