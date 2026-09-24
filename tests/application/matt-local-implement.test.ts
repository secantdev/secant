import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type {
  HarnessAdapter,
  HarnessProfile,
} from "../../src/harness/harness.js";
import type {
  ActionOffer,
  RunView,
} from "../../src/application/projection-port.js";
import {
  createFake,
  type FakeScript,
  type FakeTurnScript,
} from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

// [matt-local-implement] The maintained Matt Bundle implements one Local ticket per
// fresh Session (#224), over the shared Projection Port with the real Application
// and Run Store on a temporary home and a fake Harness under each v1 Harness
// selection. After the tickets are published, every implementation iteration opens
// a fresh Session whose Entry Turn tells the agent to read the Local tracker again,
// choose one unblocked ready ticket and state its path, and follow the original
// implement folder with tdd, code-review and codebase-design beside it. Questions
// stay in that Session; Continue opens the next one without closing a ticket, and
// only a confirmed End Stage ends the Run. Secant never edits a ticket file or
// keeps a ticket list, and a no-work, interrupted or lost Turn never moves on to
// another ticket.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MATT_FOLDER = join(repoRoot, "bundles", "matt-front-spec");
const MATT_ID = "dev.secant.matt-front";
const IDEA = "Add a dark-mode toggle that follows me across devices.";
const RECEIPT_LINE =
  /Write the required output "spec-ref" as UTF-8 text to (.+) before you finish;/;
const TICKETS_RECEIPT_LINE =
  /Write the required output "tickets-ref" as UTF-8 text to (.+) before you finish;/;
const IMPLEMENT_HEADING = "# Implement one ticket";
const IMPLEMENTATION_SKILLS = [
  "implement",
  "tdd",
  "code-review",
  "codebase-design",
] as const;
const TICKETS = [
  ["01-store-preference.md", "None (can start immediately)"],
  ["02-toggle-ui.md", "01"],
] as const;

type HarnessId = "claude-code" | "codex";
type TurnScript = FakeScript["turns"][number];

function profile(harness: HarnessId): HarnessProfile {
  return {
    harness: harness === "codex" ? "codex" : "Claude Code",
    executable: harness === "codex" ? "codex" : "fake-claude",
    executableVersion: "0.0.0-fake",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "process-only", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    clarifications: { available: false, evidence: "scripted fake" },
    steer: { available: harness === "codex", evidence: "scripted fake" },
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

function completed(content: string): TurnScript {
  return {
    events: [{ kind: "assistant-content", content }],
    result: {
      kind: "completed",
      detail: {
        finalContent: content,
        effectiveModel: { known: true, model: "fake-model" },
        session: { state: "detached", coordinate: { opaque: "coord" } },
      },
    },
  };
}

const BLOCKS: TurnScript = { block: true, result: completed("unused").result };

const LOST: TurnScript = {
  result: {
    kind: "lost",
    detail: {
      unknown: "completion",
      lastObservation: "the producer closed before a result",
      session: { state: "detached", coordinate: { opaque: "coord" } },
    },
  },
};

/** An Adapter playing the whole Matt agent. Planning Turns write the Local spec
 *  and tickets as the maintained prompts ask. Each implementation Turn plays the
 *  next queued script (a completed Turn when the queue is empty), after running
 *  the queued action that stands in for the agent's own work in the tracker. */
function mattAgent(harness: HarnessId) {
  const granted: (string | undefined)[] = [];
  const turns: { text: string; session: string }[] = [];
  const implementation: { script: TurnScript; act?: (area: string) => void }[] =
    [];
  const adapter: HarnessAdapter = {
    async prepare(options) {
      granted.push(options.writableDirectory);
      // The fake reads its scripted Turns by index as each Turn starts, so this
      // prepare's list grows with the Turns it actually serves.
      const served: FakeTurnScript[] = [];
      const prepared = await createFake({
        profile: profile(harness),
        turns: served,
      })().prepare(options);
      if (!prepared.ok) return prepared;
      const inner = prepared.harness;
      return {
        ok: true,
        harness: {
          profile: inner.profile,
          startTurn(request) {
            const text = request.input.text;
            turns.push({ text, session: request.session });
            const area = options.writableDirectory;
            assert.ok(area, "every Matt Turn is granted the working area");
            const specReceipt = RECEIPT_LINE.exec(text)?.[1];
            if (specReceipt !== undefined) {
              const spec = join(area, "spec.md");
              writeFileSync(spec, "# Dark mode\n");
              writeFileSync(specReceipt, `${spec}\n`);
            }
            const ticketsReceipt = TICKETS_RECEIPT_LINE.exec(text)?.[1];
            if (ticketsReceipt !== undefined) {
              const issues = join(area, "issues");
              mkdirSync(issues, { recursive: true });
              for (const [file, blockedBy] of TICKETS) {
                writeFileSync(
                  join(issues, file),
                  `# ${file}\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ready-for-agent\n`,
                );
              }
              writeFileSync(ticketsReceipt, `${issues}\n`);
            }
            const next = request.session.startsWith("implement")
              ? implementation.shift()
              : undefined;
            next?.act?.(area);
            served.push(next?.script ?? completed("ok"));
            return inner.startTurn(request);
          },
          close: () => inner.close(),
        },
      };
    },
  };
  return { adapter, granted, turns, implementation };
}

function wire(
  t: TestContext,
  harness: HarnessId,
  adapter: HarnessAdapter,
): { wired: Wiring; workspace: string; digest: string } {
  const workspace = makeTempDir("secant-matt-impl-ws-");
  const found = (name: string) => () => ({
    kind: "found" as const,
    attempt: {
      source: "path" as const,
      name,
      description: `PATH name '${name}'`,
    },
  });
  const wired = wireApplication({
    secantHome: makeTempDir("secant-matt-impl-home-"),
    launchCwd: workspace,
    supportsInteractiveTurns: true,
    process: createFakeBundleProcess(),
    discoverClaudeCode: found("claude"),
    discoverCodex: found("codex"),
    ...(harness === "codex"
      ? { codexHarnessAdapter: adapter }
      : { harnessAdapter: adapter }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  const built = wired.bundleManagement.build(MATT_FOLDER, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = wired.catalog.listEntries().find((e) => e.id === MATT_ID);
  assert.ok(entry);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  return { wired, workspace, digest: entry.digest };
}

function submit(
  wired: Wiring,
  submission: Parameters<Wiring["projectionPort"]["submit"]>[0],
): void {
  const admission = wired.projectionPort.submit(submission);
  assert.ok(admission.admitted, JSON.stringify(admission));
}

async function settle(
  wired: Wiring,
  submission: Parameters<Wiring["projectionPort"]["submit"]>[0],
): Promise<void> {
  submit(wired, submission);
  const outcome = await awaitSettled(
    wired.projectionPort,
    submission.operationId,
  );
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
}

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

async function awaitInterruptOffer(wired: Wiring, runId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const interrupt = offer(readRun(wired, runId), "interrupt-turn");
    if (interrupt !== undefined) return interrupt;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the implementation Turn never exposed its interrupt Offer");
}

/** Launch, end the grill, choose Local, and take the ticket review up to the
 *  approving End Step, whose publish Turn is followed by the first implementation
 *  Entry Turn. The End Step Operation is submitted, not awaited: it settles only
 *  once that Entry Turn does. */
async function publishLocalTickets(
  wired: Wiring,
  digest: string,
  harness: HarnessId,
): Promise<string> {
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: MATT_ID },
      launchInputs: { idea: IDEA },
      trustDigest: digest,
      harness,
    },
  });
  assert.ok(admission.admitted && admission.runId);
  const runId = admission.runId;
  await awaitSettled(wired.projectionPort, "op-launch");
  await settle(wired, {
    operationId: "op-end-grill",
    operation: "end-interactive-step",
    input: { runId, stepId: "grill" },
  });
  const gate = readRun(wired, runId).pendingGate?.gate;
  assert.equal(gate?.stepId, "choose-tracker");
  await settle(wired, {
    operationId: "op-tracker",
    operation: "answer-human-gate",
    input: { runId, gate: gate!, text: "Local" },
  });
  submit(wired, {
    operationId: "op-approve-tickets",
    operation: "end-interactive-step",
    input: { runId, stepId: "plan-tickets" },
  });
  return runId;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** Every file's bytes under `dir`, keyed by relative path. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    filesUnder(dir).map((file) => [
      file,
      readFileSync(join(dir, file), "utf8"),
    ]),
  );
}

/** The prompt names the skill's SKILL.md by a bundled path whose folder is the
 *  original one, complete and byte-identical. */
function assertBundledSkill(prompt: string, skill: string): void {
  const match = new RegExp(`(\\S*[\\\\/]${skill}[\\\\/]SKILL\\.md)`).exec(
    prompt,
  );
  assert.ok(match, prompt);
  const bundled = dirname(match[1]!);
  const source = join(MATT_FOLDER, "skills", skill);
  assert.deepEqual(filesUnder(bundled), filesUnder(source));
  for (const file of filesUnder(source)) {
    assert.deepEqual(
      readFileSync(join(bundled, file)),
      readFileSync(join(source, file)),
    );
  }
}

/** The working area's tracker files, without the Store-named receipt directory. */
function trackerFiles(area: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snapshot(area)).filter(
      ([file]) => !file.startsWith(".receipts"),
    ),
  );
}

/** The durable Turns, read through an owner once nothing is live in-process. */
function durableTurns(wired: Wiring, runId: string) {
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    return owner.turns().map((turn) => ({
      origin: turn.origin,
      session: turn.session,
      resultKind: turn.resultKind,
    }));
  } finally {
    owner.close();
  }
}

for (const harness of ["claude-code", "codex"] as const) {
  test(`[matt-local-implement] [${harness}] each ticket gets a fresh Session that reads the Local tracker; questions stay in it, and Continue opens the next without closing a ticket (#224)`, async (t) => {
    const agent = mattAgent(harness);
    // The first ticket's agent marks it done in its own file, as the prompt asks.
    agent.implementation.push({
      script: completed("I chose issues/01-store-preference.md."),
      act: (area) =>
        writeFileSync(
          join(area, "issues", TICKETS[0][0]),
          `# ${TICKETS[0][0]}\n\n**Blocked by:** ${TICKETS[0][1]}\n\n**Status:** done\n`,
        ),
    });
    const { wired, workspace, digest } = wire(t, harness, agent.adapter);
    const runId = await publishLocalTickets(wired, digest, harness);
    await awaitSettled(wired.projectionPort, "op-approve-tickets");
    const area = agent.granted.at(-1)!;
    const issues = join(area, "issues");

    // Publishing leads straight into the implementation stage's first Entry Turn,
    // in a fresh Session of its own, and the Run rests there for the human.
    const first = readRun(wired, runId);
    assert.equal(first.state, "blocked", JSON.stringify(first.progress));
    assert.deepEqual(
      first.progress.map((step) => [step.id, step.status]),
      [
        ["grill", "succeeded"],
        ["choose-tracker", "succeeded"],
        ["write-spec", "succeeded"],
        ["plan-tickets", "succeeded"],
        ["publish-tickets", "succeeded"],
        ["implement", "blocked"],
      ],
    );
    const entry = agent.turns.at(-1)!;
    assert.ok(entry.text.startsWith(IMPLEMENT_HEADING), entry.text);
    assert.notEqual(entry.session, "spec");
    // The prompt names the tracker, the spec, and the exact Local directories, and
    // asks for one unblocked ready ticket stated by its path before any work.
    assert.ok(entry.text.includes("the tracker I chose: Local."), entry.text);
    assert.ok(entry.text.includes(join(area, "spec.md")), entry.text);
    assert.ok(entry.text.includes(issues), entry.text);
    assert.ok(entry.text.includes(`\`${area}\``), entry.text);
    assert.match(entry.text, /Read the tracker now/);
    assert.match(entry.text, /Choose exactly one of them/);
    assert.match(
      entry.text,
      /Never choose a ticket with an\s+unfinished blocker/,
    );
    assert.match(entry.text, /absolute path/);
    assert.match(
      entry.text,
      /Update the chosen ticket's status in the tracker/,
    );
    for (const skill of IMPLEMENTATION_SKILLS) {
      assertBundledSkill(entry.text, skill);
    }
    // At the Turn boundary: a question, Continue, or End Stage — never End Step.
    assert.ok(offer(first, "send-interactive-turn"));
    assert.match(
      offer(first, "continue-repeat")?.consequence ?? "",
      /does not close the ticket/,
    );
    assert.match(
      offer(first, "end-stage")?.consequence ?? "",
      /Secant has not checked the tracker/,
    );
    assert.equal(offer(first, "end-interactive-step"), undefined);

    // A later question goes verbatim into the same ticket Session.
    await settle(wired, {
      operationId: "op-question",
      operation: "send-interactive-turn",
      input: { runId, stepId: "implement", text: "Which test covers this?" },
    });
    assert.deepEqual(agent.turns.at(-1), {
      text: "Which test covers this?",
      session: entry.session,
    });
    assert.equal(readRun(wired, runId).state, "blocked");
    const afterFirst = trackerFiles(area);
    assert.match(
      afterFirst[join("issues", TICKETS[0][0])]!,
      /Status:\*\* done/,
    );

    // Continue opens a fresh Session whose Entry Turn reads the tracker again. The
    // tracker is exactly as the agent left it: Secant closed and moved nothing.
    await settle(wired, {
      operationId: "op-continue",
      operation: "continue-repeat",
      input: { runId, stepId: "implement" },
    });
    const second = agent.turns.at(-1)!;
    assert.equal(second.text, entry.text);
    assert.notEqual(second.session, entry.session);
    assert.notEqual(second.session, "spec");
    assert.deepEqual(trackerFiles(area), afterFirst);
    const iteration1 = readRun(wired, runId);
    assert.equal(iteration1.state, "blocked");
    assert.equal(iteration1.progress[iteration1.position]?.id, "implement");

    // Only the confirmed End Stage ends the Run, as a human declaration.
    await settle(wired, {
      operationId: "op-end-stage",
      operation: "end-stage",
      input: { runId, stepId: "implement" },
    });
    const done = readRun(wired, runId);
    assert.equal(done.state, "succeeded");
    assert.equal(done.completion, "human-declared");
    assert.deepEqual(
      done.timeline
        .map((event) => event.event)
        .filter(
          (event) => event === "repeat-continued" || event === "stage-ended",
        ),
      ["repeat-continued", "stage-ended"],
    );
    // History keeps every ticket Session's Turns apart from the planning Session.
    assert.deepEqual(
      durableTurns(wired, runId).map((turn) => [turn.origin, turn.session]),
      [
        // The grill, spec, ticket-review and publish Turns.
        ["managed", "spec"],
        ["managed", "spec"],
        ["managed", "spec"],
        ["managed", "spec"],
        ["managed", entry.session],
        ["human", entry.session],
        ["managed", second.session],
      ],
    );
    // No ticket-status mirror: the outputs are still only the three references,
    // the working area holds only the agent's tracker files, and the Workspace
    // holds no planning file.
    assert.deepEqual(done.outputs.map((output) => output.name).sort(), [
      "spec-ref",
      "tickets-ref",
      "tracker",
    ]);
    assert.deepEqual(trackerFiles(area), afterFirst);
    assert.deepEqual(readdirSync(workspace), []);
  });
}

test("[matt-local-implement] a no-work, interrupted or lost implementation Turn stays in the same ticket Session across halt and resume (#224)", async (t) => {
  const agent = mattAgent("claude-code");
  agent.implementation.push(
    // The Entry Turn runs until the human interrupts it.
    { script: BLOCKS },
    // The human's next Turn is lost.
    { script: LOST },
    // The agent then finds no ready ticket and says so.
    { script: completed("No ticket is ready: every open ticket is blocked.") },
  );
  const { wired, digest } = wire(t, "claude-code", agent.adapter);
  const runId = await publishLocalTickets(wired, digest, "claude-code");
  const area = agent.granted.at(-1)!;

  const interrupt = await awaitInterruptOffer(wired, runId);
  await settle(wired, {
    operationId: "op-interrupt",
    operation: "interrupt-turn",
    input: { runId, turnId: interrupt.turnId },
  });
  await awaitSettled(wired.projectionPort, "op-approve-tickets");
  assert.equal(readRun(wired, runId).state, "halted");
  const published = trackerFiles(area);
  const entry = agent.turns.at(-1)!;
  assert.ok(entry.text.startsWith(IMPLEMENT_HEADING), entry.text);

  // Resume returns to the same ticket Session without re-sending the Entry Turn.
  const resume = async (operationId: string) => {
    await settle(wired, {
      operationId,
      operation: "resume-run",
      input: { runId },
    });
    const run = readRun(wired, runId);
    assert.equal(run.state, "blocked");
    assert.equal(run.progress[run.position]?.id, "implement");
    assert.ok(offer(run, "continue-repeat"));
  };
  const sentBefore = agent.turns.length;
  await resume("op-resume-1");
  assert.equal(agent.turns.length, sentBefore);

  // A lost Turn halts the Run too, and resume stays in the same Session.
  await settle(wired, {
    operationId: "op-lost",
    operation: "send-interactive-turn",
    input: { runId, stepId: "implement", text: "Please carry on." },
  });
  assert.equal(readRun(wired, runId).state, "halted");
  await resume("op-resume-2");

  // The agent reports no work; nothing advances, closes, or ends on its word.
  await settle(wired, {
    operationId: "op-no-work",
    operation: "send-interactive-turn",
    input: { runId, stepId: "implement", text: "Which ticket did you choose?" },
  });
  const rested = readRun(wired, runId);
  assert.equal(rested.state, "blocked");
  assert.equal(rested.progress[rested.position]?.id, "implement");
  assert.ok(offer(rested, "continue-repeat"));
  assert.ok(offer(rested, "end-stage"));
  assert.equal(
    rested.timeline.some(
      (event) =>
        event.event === "repeat-continued" || event.event === "stage-ended",
    ),
    false,
  );
  assert.deepEqual(trackerFiles(area), published);
  assert.deepEqual(
    durableTurns(wired, runId)
      .filter((turn) => turn.session !== "spec")
      .map((turn) => [turn.origin, turn.session, turn.resultKind]),
    [
      ["managed", entry.session, "interrupted"],
      ["human", entry.session, "lost"],
      ["human", entry.session, "completed"],
    ],
  );
});

test("[matt-local-implement] an Entry Turn that finds no ready ticket rests in its Session; the agent's word ends nothing (#224)", async (t) => {
  const agent = mattAgent("codex");
  agent.implementation.push({
    script: completed(
      "No ticket is ready. Every ticket is done, so end the stage.",
    ),
  });
  const { wired, digest } = wire(t, "codex", agent.adapter);
  const runId = await publishLocalTickets(wired, digest, "codex");
  await awaitSettled(wired.projectionPort, "op-approve-tickets");
  const area = agent.granted.at(-1)!;

  const run = readRun(wired, runId);
  assert.equal(run.state, "blocked");
  assert.equal(run.progress[run.position]?.id, "implement");
  assert.ok(offer(run, "send-interactive-turn"));
  assert.ok(offer(run, "continue-repeat"));
  assert.ok(offer(run, "end-stage"));
  assert.equal(
    run.timeline.some(
      (event) =>
        event.event === "repeat-continued" || event.event === "stage-ended",
    ),
    false,
  );
  // Secant neither closed nor rewrote a ticket after the agent's report.
  for (const [file] of TICKETS) {
    assert.match(
      trackerFiles(area)[join("issues", file)]!,
      /Status:\*\* ready-for-agent/,
    );
  }
  assert.equal(
    durableTurns(wired, runId).filter((turn) => turn.session !== "spec").length,
    1,
  );
});
