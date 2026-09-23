import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type HarnessFailure,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import type {
  ActionOffer,
  RunView,
} from "../../src/application/projection-port.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { RUNTIME_NAME } from "../helpers/commandBundle.js";
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
    modelObservation: { available: true, evidence: "scripted fake" },
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

/** The default `interactive-agent (session "s") -> agent (session "s")` Routing. */
const DEFAULT_ROUTING: readonly unknown[] = [
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
];

/** Author a Bundle over `routing` (the interactive -> agent pair by default). */
function writeInteractiveBundle(routing = DEFAULT_ROUTING): {
  folder: string;
  id: string;
} {
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
    routing,
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
  script: FakeScript | HarnessAdapter,
  counts?: {
    prepares: number;
    readonly closes: number[];
    readonly failureAfterLaunch?: HarnessFailure;
    /** Each Turn's `resume` coordinate, in start order (undefined = fresh). */
    readonly resumes?: (string | undefined)[];
    /** The script every prepare after the first serves (a fresh prepared fake
     *  otherwise replays the launch script from its first Turn). */
    readonly laterScript?: FakeScript;
  },
  routing?: readonly unknown[],
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
  const fake = "prepare" in script ? script : createFake(script)();
  const adapter: HarnessAdapter =
    counts === undefined
      ? fake
      : {
          async prepare(options) {
            counts.prepares += 1;
            if (
              counts.prepares > 1 &&
              counts.failureAfterLaunch !== undefined
            ) {
              return { ok: false, failure: counts.failureAfterLaunch };
            }
            const index = counts.closes.push(0) - 1;
            const prepared = await (
              counts.prepares > 1 && counts.laterScript !== undefined
                ? createFake(counts.laterScript)()
                : fake
            ).prepare(options);
            if (!prepared.ok) return prepared;
            const harness = prepared.harness;
            return {
              ok: true,
              harness: {
                profile: harness.profile,
                startTurn: (request) => {
                  counts.resumes?.push(request.resume?.opaque);
                  return harness.startTurn(request);
                },
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
    process: createFakeBundleProcess(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const bundle = writeInteractiveBundle(routing);
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
      harness: "claude-code",
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

test("reopened interactive preparation failure halts with a selected-Harness Problem before a Turn", async (t) => {
  const closes: number[] = [];
  const counts = {
    prepares: 0,
    closes,
    failureAfterLaunch: {
      phase: "prepare",
      category: "protocol-incompatible",
      possibleEffects: "none",
      diagnostics: "Pinned protocol subset did not qualify.",
    } satisfies HarnessFailure,
  };
  const { wired, runId } = await launchInteractive(
    t,
    { profile: profile(), turns: [COMPLETED_DETACHED] },
    counts,
  );
  await wired.shutdown();

  const sent = wired.projectionPort.submit({
    operationId: "op-send-prepare-failure",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "Continue the discussion" },
  });
  assert.ok(sent.admitted, JSON.stringify(sent));
  const outcome = await awaitSettled(wired.projectionPort, sent.operationId);
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "selected-harness-unavailable");
    assert.equal(outcome.problem.details?.harness, "claude-code");
  }
  const run = readRun(wired, runId);
  assert.equal(run.state, "halted");
  assert.equal(run.problem?.code, "selected-harness-unavailable");
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  assert.deepEqual(owner.turns(), []);
  owner.close();
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

test("an interrupted interactive Turn halts without advancing and resume returns to the same Session (#219)", async (t) => {
  const counts = {
    prepares: 0,
    closes: [] as number[],
    resumes: [] as (string | undefined)[],
    laterScript: { profile: profile(), turns: [COMPLETED_DETACHED] },
  };
  const { wired, runId } = await launchInteractive(
    t,
    {
      profile: profile(),
      turns: [
        {
          block: true,
          interruptResult: {
            kind: "interrupted",
            detail: {
              interruption: profile().interruption,
              session: {
                state: "detached",
                coordinate: { opaque: "coord-interrupted" },
              },
            },
          },
          result: COMPLETED_DETACHED.result,
        },
      ],
    },
    counts,
  );
  const sent = wired.projectionPort.submit({
    operationId: "op-send-long",
    operation: "send-interactive-turn",
    input: { runId, stepId: "discuss", text: "work on this for a while" },
  });
  assert.ok(sent.admitted);
  const interruptOffer = await awaitInterruptOffer(wired, runId);
  const interrupted = wired.projectionPort.submit({
    operationId: "op-interrupt-long",
    operation: "interrupt-turn",
    input: { runId, turnId: interruptOffer.turnId },
  });
  assert.ok(interrupted.admitted);
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-interrupt-long")).status,
    "applied",
  );
  await awaitSettled(wired.projectionPort, "op-send-long");

  // Rested `halted` at the same interactive Step: nothing settled, nothing advanced,
  // and the Session is kept recoverable rather than replaced.
  const halted = readRun(wired, runId);
  assert.equal(halted.state, "halted");
  assert.equal(halted.progress[halted.position]?.id, "discuss");
  assert.deepEqual(
    halted.progress.map((s) => s.status === "succeeded"),
    [false, false],
  );
  assert.equal(halted.sessions?.length, 1);
  assert.equal(halted.sessions?.[0]?.availability, "detached");
  assert.equal(offer(halted, "end-interactive-step"), undefined);
  const resumeOffer = offer(halted, "resume-run");
  assert.ok(resumeOffer?.available, JSON.stringify(halted.actionOffers));

  // Resume returns to the interactive boundary of the same Step.
  const resumed = wired.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resumed.admitted, JSON.stringify(resumed));
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-resume")).status,
    "applied",
  );
  const boundary = readRun(wired, runId);
  assert.equal(boundary.state, "blocked");
  assert.equal(boundary.progress[boundary.position]?.id, "discuss");
  assert.ok(offer(boundary, "send-interactive-turn"));

  // The next human Turn continues the interrupted native Session.
  await send(wired, runId, "op-send-after", "discuss", "pick up where we were");
  assert.deepEqual(counts.resumes, [undefined, "coord-interrupted"]);
  const after = readRun(wired, runId);
  assert.equal(after.state, "blocked");
  assert.equal(after.sessions?.length, 1);
  assert.equal(after.sessions?.[0]?.session, "s");
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

// --- An Interactive Step in a Verdict-driven Repeat (#216) ------------------

/** `baseline (fail) -> repeat until passing { implement (interactive, "impl") ->
 *  check (passes on its second run) }`: two iterations, each its own Attempt and
 *  Session, advanced only by End Step. */
function repeatRouting(): readonly unknown[] {
  const counter = join(makeTempDir("secant-interactive-counter-"), "counter");
  const verdict = [{ name: "passing", type: "verdict" }];
  return [
    {
      id: "baseline",
      kind: "command",
      produces: verdict,
      command: {
        executable: RUNTIME_NAME,
        arguments: ["-e", "process.exit(1)"],
      },
    },
    {
      repeat: {
        until: "passing",
        reviewCheckpoint: { interval: 5, message: "review the loop" },
        steps: [
          {
            id: "implement",
            kind: "interactive-agent",
            session: "impl",
            prompt: { asset: "prompts/discuss.md" },
          },
          {
            id: "check",
            kind: "command",
            produces: verdict,
            command: {
              executable: RUNTIME_NAME,
              arguments: [
                "-e",
                `const fs=require('node:fs');const p=${JSON.stringify(counter)};` +
                  `let n=0;try{n=Number(fs.readFileSync(p,'utf8'))||0;}catch{}` +
                  `n++;fs.writeFileSync(p,String(n));` +
                  `console.log('iteration '+n);process.exit(n>=2?0:1);`,
              ],
            },
          },
          {
            id: "apply",
            kind: "agent",
            session: "impl",
            prompt: { asset: "prompts/apply.md" },
          },
        ],
      },
    },
  ];
}

/** A Turn that blocks until it is interrupted. */
const BLOCKING: FakeScript["turns"][number] = {
  block: true,
  result: COMPLETED_DETACHED.result,
};

/** A fake Adapter whose n-th prepared Harness serves the n-th script's Turns, so
 *  each Step-scoped Harness (launch, each End, each resume) is scripted apart. */
function perPrepareAdapter(
  turnsPerPrepare: readonly FakeScript["turns"][],
): HarnessAdapter {
  let prepares = 0;
  return {
    prepare(options) {
      const turns = turnsPerPrepare[prepares++] ?? [];
      return createFake({ profile: profile(), turns })().prepare(options);
    },
  };
}

async function endStep(
  wired: Wiring,
  runId: string,
  operationId: string,
  stepId: string,
): Promise<void> {
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "end-interactive-step",
    input: { runId, stepId },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const outcome = await awaitSettled(wired.projectionPort, operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
}

function sessionsOf(run: RunView): string[] {
  return (run.sessions ?? []).map((session) => session.session).sort();
}

test("an Interactive Step in a Verdict-driven Repeat gives each iteration its own Attempt and Session; End advances one iteration; halt and resume keep it (#216)", async (t) => {
  const { wired, runId, run } = await launchInteractive(
    t,
    perPrepareAdapter([
      // Launch: iteration 0 at the interactive Step, two human Turns.
      [COMPLETED_DETACHED, COMPLETED_DETACHED],
      // End #1: the span's Agent Step runs in its own Run-wide "impl" Session, then
      // iteration 1 rests at the interactive Step; its first Turn is interrupted.
      [COMPLETED_DETACHED, BLOCKING],
      // resume-run: iteration 1 again, the same Session takes the next Turn.
      [COMPLETED_DETACHED],
      // End #2: the Agent Step, then check passes and the Run succeeds.
      [COMPLETED_DETACHED],
    ]),
    undefined,
    repeatRouting(),
  );
  assert.equal(run.state, "blocked");
  assert.equal(run.progress[run.position]?.id, "implement");
  assert.ok(offer(run, "end-interactive-step"));
  // A Verdict-driven Repeat has no Continue (#217): refused, changing nothing.
  assert.equal(offer(run, "continue-repeat"), undefined);
  const refusedContinue = await submitContinue(wired, runId, "op-continue");
  assert.equal(refusedContinue.status, "not-applied");
  if (refusedContinue.status === "not-applied") {
    assert.equal(refusedContinue.problem.code, "continue-outside-human-repeat");
  }

  // Two Turns in iteration 0: completion never advances; one conversation.
  await send(wired, runId, "op-i0-t1", "implement", "pick a ticket");
  await send(wired, runId, "op-i0-t2", "implement", "a follow-up question");
  const iteration0 = readRun(wired, runId);
  assert.equal(iteration0.state, "blocked");
  assert.equal(iteration0.progress[iteration0.position]?.id, "implement");
  assert.deepEqual(sessionsOf(iteration0), ["impl-0.0:implement"]);

  // End advances exactly this iteration: check fails, the autonomous Agent Step
  // keeps its Run-wide named Session, and iteration 1 rests at the interactive Step.
  await endStep(wired, runId, "op-end-0", "implement");
  const iteration1 = readRun(wired, runId);
  assert.equal(iteration1.state, "blocked");
  assert.equal(iteration1.progress[iteration1.position]?.id, "implement");
  assert.ok(offer(iteration1, "send-interactive-turn"));

  // Interrupt iteration 1's first Turn: the Run halts, resumable.
  const sent = wired.projectionPort.submit({
    operationId: "op-i1-t1",
    operation: "send-interactive-turn",
    input: { runId, stepId: "implement", text: "pick the next ticket" },
  });
  assert.ok(sent.admitted);
  const interruptOffer = await awaitInterruptOffer(wired, runId);
  const interrupted = wired.projectionPort.submit({
    operationId: "op-i1-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: interruptOffer.turnId },
  });
  assert.ok(interrupted.admitted);
  await awaitSettled(wired.projectionPort, interrupted.operationId);
  await awaitSettled(wired.projectionPort, sent.operationId);
  const halted = readRun(wired, runId);
  assert.equal(halted.state, "halted");
  assert.deepEqual(sessionsOf(halted), [
    "impl",
    "impl-0.0:implement",
    "impl-1.0:implement",
  ]);

  // Resume lands back in iteration 1, not a fresh iteration or iteration 0.
  const resumed = wired.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resumed.admitted, JSON.stringify(resumed));
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-resume")).status,
    "applied",
  );
  const afterResume = readRun(wired, runId);
  assert.equal(afterResume.state, "blocked");
  assert.equal(afterResume.progress[afterResume.position]?.id, "implement");
  await send(wired, runId, "op-i1-t2", "implement", "carry on");

  await endStep(wired, runId, "op-end-1", "implement");
  const done = readRun(wired, runId);
  assert.equal(done.state, "succeeded");
  assert.equal(
    done.timeline.filter((event) => event.event === "interactive-step-ended")
      .length,
    2,
  );

  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    assert.deepEqual(
      owner
        .turns()
        .map((turn) => [turn.kind, turn.attemptId, turn.session, turn.input]),
      [
        [
          "interactive-agent",
          "0.0:implement",
          "impl-0.0:implement",
          "pick a ticket",
        ],
        [
          "interactive-agent",
          "0.0:implement",
          "impl-0.0:implement",
          "a follow-up question",
        ],
        ["agent", "0.0:apply", "impl", "Apply the plan.\n"],
        [
          "interactive-agent",
          "1.0:implement",
          "impl-1.0:implement",
          "pick the next ticket",
        ],
        [
          "interactive-agent",
          "1.0:implement",
          "impl-1.0:implement",
          "carry on",
        ],
        ["agent", "1.0:apply", "impl", "Apply the plan.\n"],
      ],
    );
  } finally {
    owner.close();
  }
});

test("an entry Turn inside a Repeat opens each iteration's own Session (#212, #216)", async (t) => {
  const routing = repeatRouting().map((node) => {
    const repeat = (node as { repeat?: { steps: Record<string, unknown>[] } })
      .repeat;
    if (repeat === undefined) return node;
    // The interactive Step opts into its entry Turn; drop the span's Agent Step.
    return {
      repeat: {
        ...repeat,
        steps: repeat.steps
          .filter((step) => step.kind !== "agent")
          .map((step) =>
            step.kind === "interactive-agent"
              ? { ...step, entryTurn: true }
              : step,
          ),
      },
    };
  });
  const { wired, runId, run } = await launchInteractive(
    t,
    perPrepareAdapter([
      [COMPLETED_DETACHED],
      [COMPLETED_DETACHED],
      [COMPLETED_DETACHED],
    ]),
    undefined,
    routing,
  );
  assert.equal(run.state, "blocked");
  await endStep(wired, runId, "op-end-0", "implement");
  assert.equal(readRun(wired, runId).state, "blocked");
  await endStep(wired, runId, "op-end-1", "implement");
  assert.equal(readRun(wired, runId).state, "succeeded");

  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    assert.deepEqual(
      owner.turns().map((turn) => [turn.turnId, turn.session, turn.origin]),
      [
        ["0.0:implement#entry", "impl-0.0:implement", "managed"],
        ["1.0:implement#entry", "impl-1.0:implement", "managed"],
      ],
    );
  } finally {
    owner.close();
  }
});

/** A human-controlled Repeat (#217): `repeat { control: human } [interactive
 *  implement]`. No Verdict, no Review checkpoint — only Continue opens the next
 *  iteration (confirmed End Stage, #218, exits). */
function humanRepeatRouting(): readonly unknown[] {
  return [
    {
      repeat: {
        control: "human",
        steps: [
          {
            id: "implement",
            kind: "interactive-agent",
            session: "impl",
            prompt: { asset: "prompts/discuss.md" },
          },
        ],
      },
    },
  ];
}

async function submitContinue(
  wired: Wiring,
  runId: string,
  operationId: string,
  stepId = "implement",
) {
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "continue-repeat",
    input: { runId, stepId },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  return awaitSettled(wired.projectionPort, operationId);
}

test("a human-controlled Repeat offers Continue only at a Turn boundary; one Continue settles one iteration into a fresh Session, idempotent by Operation id, with no Review checkpoint (#217)", async (t) => {
  const { wired, runId, run } = await launchInteractive(
    t,
    perPrepareAdapter([
      // Launch: iteration 0, one completed Turn, then one that blocks until interrupt.
      [COMPLETED_DETACHED, BLOCKING],
      // resume-run: iteration 0 again.
      [],
      // Continue #1..#3: each opens the next iteration; iteration 1 takes one Turn.
      [COMPLETED_DETACHED],
      [],
      [],
    ]),
    undefined,
    humanRepeatRouting(),
  );
  // At the boundary: send + Continue, never End Step (Continue is this mode's control).
  assert.equal(run.state, "blocked");
  assert.equal(run.progress[run.position]?.id, "implement");
  assert.ok(offer(run, "send-interactive-turn"));
  const continueOffer = offer(run, "continue-repeat");
  assert.ok(continueOffer, JSON.stringify(run.actionOffers));
  assert.equal(continueOffer.stepId, "implement");
  assert.match(continueOffer.consequence, /fresh/);
  assert.equal(offer(run, "end-interactive-step"), undefined);
  // End Step is refused in this mode, changing nothing.
  const end = wired.projectionPort.submit({
    operationId: "op-end",
    operation: "end-interactive-step",
    input: { runId, stepId: "implement" },
  });
  assert.ok(end.admitted);
  const endOutcome = await awaitSettled(wired.projectionPort, "op-end");
  assert.equal(endOutcome.status, "not-applied");

  // A completed Turn never advances the iteration.
  await send(wired, runId, "op-i0-t1", "implement", "pick a ticket");
  assert.equal(readRun(wired, runId).state, "blocked");

  // A live Turn: no Continue Offer, and a Continue submission cannot race it.
  const sent = wired.projectionPort.submit({
    operationId: "op-i0-t2",
    operation: "send-interactive-turn",
    input: { runId, stepId: "implement", text: "a long question" },
  });
  assert.ok(sent.admitted);
  const interruptOffer = await awaitInterruptOffer(wired, runId);
  assert.equal(offer(readRun(wired, runId), "continue-repeat"), undefined);
  const raced = await submitContinue(wired, runId, "op-race");
  assert.equal(raced.status, "not-applied");
  if (raced.status === "not-applied") {
    assert.equal(raced.problem.code, "interactive-step-mid-turn");
  }
  const interrupted = wired.projectionPort.submit({
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: interruptOffer.turnId },
  });
  assert.ok(interrupted.admitted);
  await awaitSettled(wired.projectionPort, "op-interrupt");
  await awaitSettled(wired.projectionPort, "op-i0-t2");
  assert.equal(readRun(wired, runId).state, "halted");
  const resumed = wired.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resumed.admitted);
  await awaitSettled(wired.projectionPort, "op-resume");
  assert.equal(readRun(wired, runId).state, "blocked");

  // One Continue settles exactly iteration 0 and rests at iteration 1.
  assert.equal(
    (await submitContinue(wired, runId, "op-continue-0")).status,
    "applied",
  );
  const iteration1 = readRun(wired, runId);
  assert.equal(iteration1.state, "blocked");
  assert.equal(iteration1.progress[iteration1.position]?.id, "implement");
  assert.ok(offer(iteration1, "continue-repeat"));
  // The same Operation id again replays its admission and settles nothing new.
  assert.equal(
    (await submitContinue(wired, runId, "op-continue-0")).status,
    "applied",
  );
  await send(wired, runId, "op-i1-t1", "implement", "next ticket");
  assert.deepEqual(sessionsOf(readRun(wired, runId)), [
    "impl-0.0:implement",
    "impl-1.0:implement",
  ]);

  // Two more Continues: never a Review checkpoint, only Continue moves the loop.
  await submitContinue(wired, runId, "op-continue-1");
  await submitContinue(wired, runId, "op-continue-2");
  const later = readRun(wired, runId);
  assert.equal(later.state, "blocked");
  assert.equal(later.checkpoint, undefined);
  assert.equal(offer(later, "answer-human-gate"), undefined);
  assert.equal(
    later.timeline.filter((event) => event.event === "repeat-continued").length,
    3,
  );
  assert.equal(
    later.timeline.filter((event) => event.event === "interactive-step-ended")
      .length,
    0,
  );

  // Cancel releases the held blocked owner so the store can be read directly.
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-cancel",
      operation: "cancel-run",
      input: { runId },
    }).admitted,
  );
  await awaitSettled(wired.projectionPort, "op-cancel");
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    assert.deepEqual(
      owner.attemptLog().map((entry) => [entry.attemptId, entry.outcome]),
      [
        ["0.0:implement", "succeeded"],
        ["1.0:implement", "succeeded"],
        ["2.0:implement", "succeeded"],
      ],
    );
    assert.deepEqual(
      owner.turns().map((turn) => [turn.attemptId, turn.session, turn.input]),
      [
        ["0.0:implement", "impl-0.0:implement", "pick a ticket"],
        ["0.0:implement", "impl-0.0:implement", "a long question"],
        ["1.0:implement", "impl-1.0:implement", "next ticket"],
      ],
    );
  } finally {
    owner.close();
  }
});
