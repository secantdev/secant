import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal, type Accessor } from "solid-js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSnapshot,
  LaunchRunInput,
  RunView,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";
import { wireApplication } from "../../src/composition/main.js";
import { createClaudeCodeAdapter } from "../../src/harness/harness.js";
import {
  App,
  createLiveRunWorkbenchView,
  type BundleCatalogView,
  type LaunchOutcome,
  type RunLaunchView,
  type WorkspaceView,
} from "../../src/tui/tui.js";
import { makeFakeRenderer } from "./renderer-fixture.js";
import { installReplayer } from "../harness/replayer.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { inertRunActionsView, inertRunListView } from "./inert.js";

// #123: the maintained Matt front Bundle — `interactive-agent` grill (Session
// "spec") -> `human-gate` `approve-reject` -> `agent` writes the spec in the same
// Session — built, installed, trusted, and run in the TUI through the in-memory
// renderer against the recorded Claude Code replayer on a temporary PATH. Nothing
// here is faked in place of a spawn: the real Adapter discovers and spawns the
// PATH-installed replayer, which replays the recorded grill and spec Turns. The
// two human grill Turns are sent, End Step is confirmed, the approve gate is
// answered, and the spec Turn's file-write approval is allowed from the Workbench;
// the Run reaches `succeeded` with the spec written in the same Session.

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MATT_FRONT_BUNDLE = join(PROJECT_ROOT, "bundles", "matt-front-spec");
const MATT_FRONT_FIXTURE = join(
  PROJECT_ROOT,
  "tests",
  "harness",
  "fixtures",
  "claude-code",
  "matt-front",
);
// The replayer echoes whichever Session id the Adapter mints, so any UUID works;
// use the recording's own for a transcript that reads exactly as it was recorded.
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPLAYER_VERSION = "2.1.274 (Claude Code)";

function workspaceView(snapshot: WorkspaceSnapshot): WorkspaceView {
  const [value] = createSignal(snapshot);
  return { snapshot: value, approve() {} };
}

function catalogView(
  list: BundleCatalogSnapshot,
  focus: BundleFocusSnapshot,
): BundleCatalogView {
  const [listValue] = createSignal(list);
  const [focusValue] = createSignal(focus);
  return { openList: () => listValue, openFocus: () => focusValue };
}

test("the Matt front runs in the TUI against the replayer to succeeded (#123)", async (t) => {
  // Discover the recorded replayer by PATH, exactly as the headless e2e does; drop
  // any configured executable so only the temporary PATH selects the fake Harness.
  const replayer = installReplayer(REPLAYER_VERSION, MATT_FRONT_FIXTURE);
  const savedPath = process.env.PATH;
  const savedConfigured = process.env.SECANT_CLAUDE_CODE;
  process.env.PATH = replayer.path;
  delete process.env.SECANT_CLAUDE_CODE;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedConfigured === undefined) delete process.env.SECANT_CLAUDE_CODE;
    else process.env.SECANT_CLAUDE_CODE = savedConfigured;
  });

  const workspace = makeTempDir("secant-matt-front-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-matt-front-home-"),
    launchCwd: workspace,
    supportsInteractiveTurns: true,
    harnessAdapter: createClaudeCodeAdapter({ sessionId: () => SESSION_ID }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const built = wired.bundleManagement.build(MATT_FRONT_BUNDLE, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = wired.catalog
    .listEntries()
    .find((item) => item.id === "dev.secant.matt-front");
  assert.ok(entry);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "approve-ws",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );

  const workspaceProjection = wired.projectionPort.openProjection({
    family: "workspace",
  });
  const listProjection = wired.projectionPort.openProjection({
    family: "bundle-catalog",
  });
  const focusProjection = wired.projectionPort.openProjection({
    family: "bundle-catalog",
    focus: { id: entry.id },
  });
  t.after(() => {
    workspaceProjection.close();
    listProjection.close();
    focusProjection.close();
  });

  // A launch seam with a fixed Operation id (mirroring createLiveRunLaunchView),
  // so the test can await the launch Operation's settlement. The launch rests the
  // Run `blocked` at the interactive Step and only then clears its execution claim;
  // sending a human Turn before that settles is refused `interactive-turn-busy`, so
  // awaiting this Operation is the correct gate, not a retry.
  const LAUNCH_OP = "matt-front-launch";
  let launched: Accessor<LaunchOutcome> | undefined;
  const launch: RunLaunchView = {
    launch(input: LaunchRunInput) {
      const [outcome, setOutcome] = createSignal<LaunchOutcome>({
        kind: "pending",
      });
      const admission = wired.projectionPort.submit({
        operationId: LAUNCH_OP,
        operation: "launch-run",
        input,
      });
      if (!admission.admitted || admission.runId === undefined) {
        setOutcome(
          admission.admitted
            ? { kind: "pending" }
            : { kind: "refused", problem: admission.problem },
        );
      } else {
        const run = wired.projectionPort.openProjection({
          family: "run",
          runId: admission.runId,
        });
        const result = run.snapshot.result;
        run.close();
        setOutcome(
          result.found
            ? {
                kind: "launched",
                runId: admission.runId,
                state: result.run.state,
              }
            : { kind: "refused", problem: result.problem },
        );
      }
      launched = outcome;
      return outcome;
    },
  };
  const runView = createLiveRunWorkbenchView(wired.projectionPort);
  const fakeRenderer = makeFakeRenderer(120, 40);
  const rendered = await testRender(
    () => (
      <App
        view={workspaceView(workspaceProjection.snapshot)}
        bundles={catalogView(listProjection.snapshot, focusProjection.snapshot)}
        launch={launch}
        run={runView}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={fakeRenderer.port}
        exit={() => {}}
      />
    ),
    { width: 120, height: 40 },
  );

  // Reach the Bundle, acknowledge Trust, and launch — the real Start-a-Run path.
  await rendered.waitForFrame((frame) => frame.includes("Secant"));
  rendered.mockInput.pressArrow("down");
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("acknowledge"));
  rendered.mockInput.pressKey("a");
  await rendered.waitForFrame((frame) => frame.includes("Trust acknowledged"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("Review"));
  rendered.mockInput.pressEnter();

  // The Run rests `blocked` at the interactive grill Step, handing the Session to
  // the human.
  await rendered.waitForFrame((frame) => frame.includes("Your Turn"));
  const receipt = launched?.();
  assert.equal(receipt?.kind, "launched");
  if (receipt?.kind !== "launched") throw new Error("Run was not launched");
  const runId = receipt.runId;
  // Await the launch Operation itself: execution rests the Run `blocked` at the
  // interactive Step and only then releases its execution claim, so a human Turn is
  // accepted only after this settles.
  assert.equal(
    (await awaitSettled(wired.projectionPort, LAUNCH_OP)).status,
    "applied",
  );
  // Read the current Run snapshot. A projection's `snapshot` is fixed at open, so
  // reopen per read to observe the Turns as they land (the headless suites do this).
  const readRun = (): RunView => {
    const projection = wired.projectionPort.openProjection({
      family: "run",
      runId,
    });
    try {
      const result = projection.snapshot.result;
      assert.ok(result.found, JSON.stringify(result));
      if (!result.found) throw new Error("unreachable");
      return result.run;
    } finally {
      projection.close();
    }
  };
  // Send one human grill Turn from the Workbench's send seam and await its
  // settlement. The launch (and each prior send) settles the Run back to the Turn
  // boundary before this runs, so the send is always admitted at a boundary.
  let grillTurn = 0;
  const sendGrillTurn = async (text: string): Promise<void> => {
    const operationId = `grill-${++grillTurn}`;
    assert.ok(
      wired.projectionPort.submit({
        operationId,
        operation: "send-interactive-turn",
        input: { runId, stepId: "grill", text },
      }).admitted,
    );
    const outcome = await awaitSettled(wired.projectionPort, operationId);
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  };

  // Two human grill Turns over the real Port (the Workbench's send seam): each is
  // one Turn whose verbatim text is the transcript input; the replayer replays the
  // recorded agent reply, resuming the same Session on the second Turn.
  await sendGrillTurn("Interview me about a feature.");
  await sendGrillTurn("That is enough context.");

  const afterGrill = readRun();
  assert.equal(afterGrill.state, "blocked");
  const transcriptReference = afterGrill.sessions?.[0]?.transcriptPage;
  assert.ok(transcriptReference);
  const transcript = wired.projectionPort.readTranscript(transcriptReference);
  assert.ok(transcript.found);
  if (!transcript.found) throw new Error("unreachable");
  const humanTurns = transcript.entries
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content);
  assert.deepEqual(humanTurns, [
    "Interview me about a feature.",
    "That is enough context.",
  ]);
  const assistantText = transcript.entries
    .filter((entry) => entry.role === "assistant")
    .map((entry) => entry.content)
    .join("\n");
  // The recorded grill: a question on the first Turn, a confirmation on the second.
  assert.match(assistantText, /persist per-device|sync across/);
  assert.match(assistantText, /enough to design|Ready when you are/);
  // #124: a detached Session that recorded human Turns still advertises its
  // transcript page/export References alongside its availability.
  assert.deepEqual(afterGrill.sessions, [
    {
      session: "spec",
      availability: "detached",
      transcriptPage: { runId, session: "spec", type: "transcript-page" },
      transcriptExport: { runId, session: "spec", type: "transcript-export" },
    },
  ]);

  // End the interactive Step at a Turn boundary; the Run advances to the authored
  // approve-reject gate and rests `blocked` at it.
  assert.ok(
    wired.projectionPort.submit({
      operationId: "end-grill",
      operation: "end-interactive-step",
      input: { runId, stepId: "grill" },
    }).admitted,
  );
  assert.equal(
    (await awaitSettled(wired.projectionPort, "end-grill")).status,
    "applied",
  );
  const atGate = readRun();
  assert.equal(atGate.pendingGate?.gate.shape, "approve-reject");
  assert.equal(atGate.pendingGate?.gate.stepId, "approve-spec");

  // Approve the gate through the Workbench's answer seam (the same answer-human-gate
  // Operation a control dispatches). This drives the spec Agent Step, which resumes
  // the Session and raises the file-write approval, then blocks awaiting it.
  const gate = atGate.pendingGate!.gate;
  // Watch the live overlay for the spec Turn's outstanding approval. The Step spawns
  // the Harness asynchronously, so wait on the overlay update (not just render passes,
  // which would give up before the async request lands). The App shares the Port, so
  // once this observer sees the request the App's Workbench has it too.
  const overlayWatch = wired.projectionPort.openProjection({
    family: "run",
    runId,
  });
  wired.projectionPort.submit({
    operationId: "answer-gate",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "continue" },
  });
  const requestSeen = (async () => {
    for await (const update of overlayWatch.updates) {
      if (update.kind === "live" && update.overlay.outstanding.length > 0)
        return;
    }
    throw new Error("the spec Turn raised no approval request");
  })();
  await requestSeen;
  overlayWatch.close();

  // The spec Turn's file-write approval now shows as the Harness Request control;
  // allow it from the Workbench, through the control, over the real Port (#121).
  await rendered.waitForFrame(
    (frame) => frame.includes("Harness Request") && frame.includes("[ Allow ]"),
  );
  fakeRenderer.key("return");

  // The spec Turn completes, applies the recorded Workspace patch, and the Run
  // reaches `succeeded`; the answer-gate drive settles once the Run rests.
  assert.equal(
    (await awaitSettled(wired.projectionPort, "answer-gate")).status,
    "applied",
  );
  await rendered.waitForFrame((frame) => frame.includes("SUCCEEDED"));

  const done = readRun();
  assert.equal(done.state, "succeeded");
  assert.deepEqual(
    done.progress.map((step) => step.status),
    ["succeeded", "succeeded", "succeeded"],
  );
  const specFile = join(workspace, "specs", "spec.md");
  assert.ok(existsSync(specFile), "the spec Turn wrote specs/spec.md");
  assert.match(readFileSync(specFile, "utf8"), /Dark Mode Toggle/);
});
