import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type {
  HarnessAdapter,
  HarnessProfile,
  PreparedHarness,
} from "../../src/harness/harness.js";
import type { RunView } from "../../src/application/projection-port.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

// [matt-remote-spec] The maintained Matt Bundle's spec stage for a remote tracker
// (#221), over the shared Projection Port with the real Application and Run Store on
// a temporary home and a fake Harness under each v1 Harness selection. After the grill
// and the tracker gate, the spec Step continues the same planning Session with the
// original to-spec skill and the chosen tracker in its prompt. GitHub and a typed
// Other go through the same generic Agent Step contract: the agent publishes with its
// own tools (Secant has no tracker Adapter) and writes the reference to its Output
// receipt. An unavailable tracker is a completed Turn with no receipt, which fails
// the Step once — no retry publishes again, and no other tracker is substituted.
// After the spec, the Run rests at ticket review; the [matt-remote-tickets] cases
// below cover that stage.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MATT_FOLDER = join(repoRoot, "bundles", "matt-front-spec");
const MATT_ID = "dev.secant.matt-front";
const RECEIPT_LINE =
  /Write the required output "(spec-ref|tickets-ref)" as UTF-8 text to (.+) before you finish;/;

type HarnessId = "claude-code" | "codex";

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

function completed(content: string): FakeScript["turns"][number] {
  return {
    events: [{ kind: "assistant-content", content }],
    result: {
      kind: "completed",
      detail: {
        finalContent: content,
        effectiveModel: { known: true, model: "fake-model" },
        session: { state: "detached", coordinate: { opaque: "coord-spec" } },
      },
    },
  };
}

/** A fake agent: Turn `n` answers `turns[n].reply` and, when `turns[n].receipt` is
 *  set, writes it to the receipt path its prompt names. Turns are numbered across every prepare
 *  (launch and each reopen), and every Turn input is kept. */
function trackerAgent(
  harness: HarnessId,
  turns: readonly { reply: string; receipt?: string }[],
): { adapter: HarnessAdapter; inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    adapter: {
      async prepare(options) {
        const prepared: PreparedHarness[] = [];
        for (const turn of turns) {
          const one = await createFake({
            profile: profile(harness),
            turns: [completed(turn.reply)],
          })().prepare(options);
          if (!one.ok) return one;
          prepared.push(one.harness);
        }
        return {
          ok: true,
          harness: {
            profile: profile(harness),
            startTurn(request) {
              const index = inputs.length;
              inputs.push(request.input.text);
              const receipt = turns[index]?.receipt;
              const path = RECEIPT_LINE.exec(request.input.text)?.[2];
              if (receipt !== undefined && path !== undefined) {
                writeFileSync(path, receipt);
              }
              const next = prepared[index];
              if (next === undefined) throw new Error("unscripted Turn");
              return next.startTurn(request);
            },
            close: async () =>
              (await Promise.all(prepared.map((p) => p.close())))[0]!,
          },
        };
      },
    },
  };
}

function wire(
  t: TestContext,
  harness: HarnessId,
  adapter: HarnessAdapter,
): { wired: Wiring; digest: string } {
  const workspace = makeTempDir("secant-matt-remote-spec-ws-");
  const found = (name: string) => () => ({
    kind: "found" as const,
    attempt: {
      source: "path" as const,
      name,
      description: `PATH name '${name}'`,
    },
  });
  const wired = wireApplication({
    secantHome: makeTempDir("secant-matt-remote-spec-home-"),
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
  return { wired, digest: entry.digest };
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

async function submitAndSettle(
  wired: Wiring,
  submission: Parameters<Wiring["projectionPort"]["submit"]>[0],
) {
  const admission = wired.projectionPort.submit(submission);
  assert.ok(admission.admitted, JSON.stringify(admission));
  const outcome = await awaitSettled(
    wired.projectionPort,
    submission.operationId,
  );
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
}

/** Launch, end the grill after its entry Turn, and answer the tracker gate; the spec
 *  Step then runs. Returns the settled Run. */
async function driveToSpec(
  wired: Wiring,
  digest: string,
  harness: HarnessId,
  tracker: string,
): Promise<{ runId: string; run: RunView }> {
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: MATT_ID },
      launchInputs: { idea: "Add a dark-mode toggle." },
      trustDigest: digest,
      harness,
    },
  });
  assert.ok(admission.admitted && admission.runId, JSON.stringify(admission));
  const runId = admission.runId;
  await awaitSettled(wired.projectionPort, "op-launch");
  await submitAndSettle(wired, {
    operationId: "op-end",
    operation: "end-interactive-step",
    input: { runId, stepId: "grill" },
  });
  const gate = readRun(wired, runId).pendingGate;
  assert.equal(gate?.gate.stepId, "choose-tracker");
  await submitAndSettle(wired, {
    operationId: "op-tracker",
    operation: "answer-human-gate",
    input: { runId, gate: gate!.gate, text: tracker },
  });
  return { runId, run: readRun(wired, runId) };
}

function readOutput(
  wired: Wiring,
  run: RunView,
  name: string,
): string | undefined {
  const output = run.outputs.find((candidate) => candidate.name === name);
  if (output === undefined) return undefined;
  const read = wired.projectionPort.readResource(output.reference);
  assert.ok(read.found, JSON.stringify(read));
  return read.content;
}

/** The durable Turns, read through an owner once nothing is live in-process. */
function turnSessions(wired: Wiring, runId: string) {
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    return owner.turns().map((turn) => [turn.kind, turn.session]);
  } finally {
    owner.close();
  }
}

/** The spec prompt names the chosen tracker exactly once, points at the complete,
 *  unedited to-spec folder by its bundled path, and asks for the receipt. */
function assertSpecPrompt(prompt: string, tracker: string): void {
  assert.equal(prompt.split(`the tracker I chose: ${tracker}.`).length, 2);
  assert.match(prompt, /repository's own configuration/);
  const match = /(\S*[\\/]to-spec[\\/]SKILL\.md)/.exec(prompt);
  assert.ok(match, `to-spec path missing from: ${prompt}`);
  const bundled = dirname(match[1]!);
  for (const file of ["SKILL.md", join("agents", "openai.yaml")]) {
    const path = join(bundled, file);
    assert.ok(existsSync(path), path);
    assert.deepEqual(
      readFileSync(path),
      readFileSync(join(MATT_FOLDER, "skills", "to-spec", file)),
    );
  }
  assert.equal(RECEIPT_LINE.exec(prompt)?.[1], "spec-ref");
}

for (const harness of ["claude-code", "codex"] as const) {
  for (const [tracker, reference] of [
    ["GitHub", "https://github.com/example/app/issues/7"],
    ["Linear", "LIN-42"],
  ] as const) {
    test(`[matt-remote-spec] [${harness}] a ${tracker} spec is published through the Harness tools and its reference is kept (#221)`, async (t) => {
      const agent = trackerAgent(harness, [
        { reply: "Q1 - Who toggles it? Recommended: each user." },
        {
          reply: `Published the spec: ${reference}`,
          receipt: `${reference}\n`,
        },
        { reply: "Proposed breakdown: 1. Toggle. 2. Persist." },
      ]);
      const { wired, digest } = wire(t, harness, agent.adapter);
      const { runId, run } = await driveToSpec(wired, digest, harness, tracker);

      // The Run moves on to ticket review (#223) and rests there.
      assert.equal(run.state, "blocked");
      assert.equal(agent.inputs.length, 3);
      assertSpecPrompt(agent.inputs[1]!, tracker);
      // The reference is a Run output for ticket planning; the choice stays bound.
      assert.equal(readOutput(wired, run, "spec-ref"), reference);
      assert.equal(readOutput(wired, run, "tracker"), tracker);
      // The spec Turn continues the grill's planning Session.
      assert.deepEqual(turnSessions(wired, runId).slice(0, 2), [
        ["interactive-agent", "spec"],
        ["agent", "spec"],
      ]);
    });
  }

  test(`[matt-remote-spec] [${harness}] an unavailable tracker fails the spec Step without switching trackers or retrying (#221)`, async (t) => {
    // The agent finishes its Turn reporting the missing connection and writes no
    // receipt; a completed Turn is not proof of publication.
    const agent = trackerAgent(harness, [
      { reply: "Q1 - Who toggles it? Recommended: each user." },
      { reply: "Linear is not connected to my tools, so I did not publish." },
    ]);
    const { wired, digest } = wire(t, harness, agent.adapter);
    const { run } = await driveToSpec(wired, digest, harness, "Linear");

    assert.equal(run.state, "failed");
    // One spec Turn only: a retry could publish a duplicate spec.
    assert.equal(agent.inputs.length, 2);
    assertSpecPrompt(agent.inputs[1]!, "Linear");
    assert.equal(readOutput(wired, run, "spec-ref"), undefined);
    assert.equal(readOutput(wired, run, "tracker"), "Linear");
    assert.deepEqual(
      run.timeline
        .filter((event) => event.event === "turn-settled")
        .map((event) => event.detail),
      ["completed", "completed"],
    );
  });
}

// [matt-remote-tickets] Ticket planning for a remote tracker (#223). The original
// to-tickets skill continues the same planning Session: the review Step proposes and
// revises the breakdown across Turns; its prompt forbids publication, it asks for no
// receipt, and agent prose never ends it. (Secant has no tracker Adapter, so the
// prompt is the only guard against an agent publishing early with its own tools.) The human's End Step is the approval;
// only then does the one-Turn publish Step create the tickets, parented to the spec
// with native blocking links, and return their references through its receipt. Secant
// keeps those references as agent observations and stores no ticket status.

const TICKETS =
  "https://github.com/example/app/issues/8\nhttps://github.com/example/app/issues/9\n";

async function sendTurn(wired: Wiring, runId: string, text: string) {
  await submitAndSettle(wired, {
    operationId: `op-turn-${text.length}`,
    operation: "send-interactive-turn",
    input: { runId, stepId: "plan-tickets", text },
  });
}

/** The prompt points at the complete, unedited to-tickets folder. */
function assertToTickets(prompt: string): void {
  const match = /(\S*[\\/]to-tickets[\\/]SKILL\.md)/.exec(prompt);
  assert.ok(match, `to-tickets path missing from: ${prompt}`);
  const bundled = dirname(match[1]!);
  for (const file of ["SKILL.md", join("agents", "openai.yaml")]) {
    assert.deepEqual(
      readFileSync(join(bundled, file)),
      readFileSync(join(MATT_FOLDER, "skills", "to-tickets", file)),
    );
  }
}

for (const harness of ["claude-code", "codex"] as const) {
  for (const [tracker, specRef] of [
    ["GitHub", "https://github.com/example/app/issues/7"],
    ["Linear", "LIN-42"],
  ] as const) {
    test(`[matt-remote-tickets] [${harness}] ${tracker} tickets are published only after the human approves the revised breakdown (#223)`, async (t) => {
      const agent = trackerAgent(harness, [
        { reply: "Q1 - Who toggles it? Recommended: each user." },
        { reply: `Published the spec: ${specRef}`, receipt: `${specRef}\n` },
        { reply: "Proposed: 1. Toggle (none). 2. Persist (blocked by 1)." },
        { reply: "Merged. You approved it, so I will publish now." },
        { reply: "Published 2 tickets.", receipt: TICKETS },
      ]);
      const { wired, digest } = wire(t, harness, agent.adapter);
      const { runId } = await driveToSpec(wired, digest, harness, tracker);

      // The review's entry Turn reads the published spec with to-tickets and must
      // not publish: it names no receipt, and the Run rests at a Turn boundary.
      const review = agent.inputs[2]!;
      assertToTickets(review);
      assert.ok(review.includes(specRef), review);
      assert.ok(review.includes(`tracker I chose: ${tracker}.`), review);
      assert.match(review, /Do not publish/);
      assert.match(review, /End Step/);
      assert.equal(RECEIPT_LINE.exec(review), null);
      let run = readRun(wired, runId);
      assert.equal(run.state, "blocked");
      assert.equal(readOutput(wired, run, "tickets-ref"), undefined);

      // A revision Turn in the same Session; the agent claiming approval ends nothing.
      await sendTurn(wired, runId, "Merge them into one ticket.");
      run = readRun(wired, runId);
      assert.equal(run.state, "blocked");
      assert.equal(agent.inputs.length, 4);
      assert.equal(agent.inputs[3], "Merge them into one ticket.");

      // End Step is the approval; the publish Turn follows in the same Session.
      await submitAndSettle(wired, {
        operationId: "op-approve-tickets",
        operation: "end-interactive-step",
        input: { runId, stepId: "plan-tickets" },
      });
      run = readRun(wired, runId);
      assert.equal(run.state, "succeeded", JSON.stringify(run.progress));
      assert.equal(agent.inputs.length, 5);
      const publish = agent.inputs[4]!;
      assertToTickets(publish);
      assert.ok(publish.includes(`tracker I chose: ${tracker}.`), publish);
      assert.ok(publish.includes(`parent is the spec at ${specRef}`), publish);
      assert.match(publish, /blocking/);
      assert.match(publish, /triage label the skill names/);
      assert.equal(RECEIPT_LINE.exec(publish)?.[1], "tickets-ref");

      // The references are kept as agent observations; no status list is stored.
      assert.equal(readOutput(wired, run, "tickets-ref"), TICKETS.trimEnd());
      assert.deepEqual(run.outputs.map((output) => output.name).sort(), [
        "spec-ref",
        "tickets-ref",
        "tracker",
      ]);
      assert.deepEqual(turnSessions(wired, runId), [
        ["interactive-agent", "spec"],
        ["agent", "spec"],
        ["interactive-agent", "spec"],
        ["interactive-agent", "spec"],
        ["agent", "spec"],
      ]);
    });
  }

  test(`[matt-remote-tickets] [${harness}] an unavailable tracker at publication fails once without a receipt (#223)`, async (t) => {
    const agent = trackerAgent(harness, [
      { reply: "Q1 - Who toggles it? Recommended: each user." },
      { reply: "Published LIN-42", receipt: "LIN-42\n" },
      { reply: "Proposed: 1. Toggle." },
      { reply: "Linear is no longer connected, so I published nothing." },
    ]);
    const { wired, digest } = wire(t, harness, agent.adapter);
    const { runId } = await driveToSpec(wired, digest, harness, "Linear");
    await submitAndSettle(wired, {
      operationId: "op-approve-tickets",
      operation: "end-interactive-step",
      input: { runId, stepId: "plan-tickets" },
    });

    const run = readRun(wired, runId);
    assert.equal(run.state, "failed");
    // One publish Turn only: a retry could publish duplicate tickets.
    assert.equal(agent.inputs.length, 4);
    assert.equal(
      run.progress.find((step) => step.id === "publish-tickets")?.status,
      "failed",
    );
    // Every Turn completed: the missing receipt alone failed the Step.
    assert.deepEqual(
      run.timeline
        .filter((event) => event.event === "turn-settled")
        .map((event) => event.detail),
      ["completed", "completed", "completed", "completed"],
    );
    assert.equal(readOutput(wired, run, "tickets-ref"), undefined);
    assert.equal(readOutput(wired, run, "spec-ref"), "LIN-42");
  });
}
