import assert from "node:assert/strict";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App, createLiveRunLaunchView } from "../../src/tui/tui.js";
import { inertRunActionsView, inertRunListView } from "./inert.js";
import type {
  BundleCatalogView,
  HarnessCatalogView,
  LaunchPreparationView,
  LaunchOutcome,
  RunLaunchView,
  RunWorkbenchView,
  WorkspaceView,
} from "../../src/tui/tui.js";
import { makeFakeRenderer, until } from "./renderer-fixture.js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSelector,
  BundleFocusSnapshot,
  HarnessCatalogSnapshot,
  HarnessFocus,
  HarnessFocusSelector,
  HarnessFocusSnapshot,
  HarnessSummary,
  InstalledBundleFocus,
  LaunchPreparationSnapshot,
  LaunchRunInput,
  OpenedProjection,
  OperationSnapshot,
  Problem,
  ProjectionPort,
  ProjectionSelector,
  RunSnapshot,
  Submission,
  SubmissionAdmission,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";

// In-memory renderer tests for the Start-a-Run flow (#90, #191, #192). They drive
// the real App over fake Bundle, Harness, launch-preparation, and launch seams:
// assessment states and complete Review fields, ready-only submission, precise
// inline findings, every correction route with selective clearing, the dismissible
// refusal notice, and success into the Workbench. The last group exercises the live
// launch seam over fake `operation`/`run` snapshots.
//
// #191 slice coverage (AC7): keymap and focus (choose/model/inputs bindings and the
// spawn-free-until-choose Harness step), terminal layout and small sizes (40/30-col
// relayout without overflow), colour-independent status (worded qualification and
// model, never a raw enum), interaction tuning (the two-phase Harness step), and
// renderer evidence (every model-field variant and the `N of M` count). Timeline
// mechanics and large content do not apply — this slice owns no timeline or
// scrollable region — and the Windows Terminal check does not apply because it
// changes neither the renderer nor a pin.
//
// #192 slice coverage: Review and refusal tests cover keyboard focus, 40x20 and
// narrow layouts, worded colour-independent states, notice dismissal, and the
// fake-view-seam renderer path. Timeline mechanics and large content do not apply;
// renderer/pin code is unchanged, so the Windows Terminal check does not apply.

const WORKSPACE = "/tmp/secant-launch-workspace";

const DEFAULT_HARNESSES: WorkspaceSnapshot["harnesses"] = [
  { id: "claude-code", name: "Claude Code", availability: "available" },
  { id: "codex", name: "Codex", availability: "available" },
];

function approvedWorkspace(
  harnesses: WorkspaceSnapshot["harnesses"] = DEFAULT_HARNESSES,
): WorkspaceView {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    family: "workspace",
    path: WORKSPACE,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 2,
    harnesses,
    actionOffers: [],
  });
  return { snapshot, approve() {} };
}

// --- fake bundle-catalog ---------------------------------------------------

function focus(
  over: Partial<InstalledBundleFocus> & { id: string },
): InstalledBundleFocus {
  const digest = over.digest ?? `digest-${over.id}`;
  return {
    id: over.id,
    version: over.version ?? "1.0.0",
    digest,
    name: over.name ?? over.id,
    description: over.description ?? "A bundle.",
    origin: over.origin ?? { kind: "local-file", location: "/bundles/x.wfb" },
    stability: over.stability ?? "stable",
    platforms: over.platforms ?? ["linux"],
    engine: over.engine ?? { range: ">=0.1.0", satisfied: true },
    trust: over.trust ?? { state: "app-release" },
    author: over.author ?? {},
    launchInputs: over.launchInputs ?? [],
    routing: over.routing ?? [
      { node: "step", step: { id: "build", kind: "command" } },
    ],
    workspacePrerequisites: over.workspacePrerequisites ?? [],
    producedArtifacts: over.producedArtifacts ?? [],
    executionSummary: over.executionSummary ?? {
      platform: "linux",
      identity: { id: over.id, version: over.version ?? "1.0.0" },
      digest,
      origin: over.origin ?? { kind: "local-file", location: "/bundles/x.wfb" },
      platforms: ["linux"],
      stepKindCounts: { command: 1 },
      commands: [],
      warning: "Commands run with your user's authority.",
    },
    compositionFindings: over.compositionFindings ?? [],
  };
}

function catalog(bundles: readonly InstalledBundleFocus[]): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles },
  });
  return {
    openList: () => list,
    openFocus: (selector: BundleFocusSelector) => {
      const bundle = bundles.find(
        (candidate) =>
          candidate.id === selector.id &&
          (selector.version === undefined ||
            candidate.version === selector.version),
      );
      const [snapshot] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result:
          bundle !== undefined
            ? { found: true, bundle }
            : {
                found: false,
                problem: {
                  code: "bundle-not-installed",
                  explanation: "gone",
                  remediation: "install",
                  possibleEffects: "none",
                },
              },
      });
      return snapshot;
    },
  };
}

// --- fake harness-catalog --------------------------------------------------

interface HarnessSpec {
  readonly id: "claude-code" | "codex";
  readonly name: string;
  /** A declared model list, `"free-text"`, or `undefined` for none. */
  readonly models?: readonly string[] | "free-text";
  /** When present, focus resolves unavailable with this Problem. */
  readonly unavailable?: Problem;
  /** When present, the list-view discovery is not-found (colour-independent
   *  unavailability visible before focusing). */
  readonly notFound?: boolean;
}

const OBSERVATION = {
  executable: "/usr/bin/harness",
  executableVersion: "1.0.0",
  platform: "linux" as const,
  checkedAt: "2026-01-01T00:00:00.000Z",
};

function summaryOf(spec: HarnessSpec): HarnessSummary {
  return {
    id: spec.id,
    name: spec.name,
    discovery: spec.notFound
      ? {
          state: "not-found",
          searched: ["/usr/bin"],
          executableEnvironmentVariable: "SECANT_HARNESS",
        }
      : { state: "found", source: "path", description: "/usr/bin/harness" },
    qualification: { state: "not-checked" },
  };
}

function focusOf(spec: HarnessSpec): HarnessFocus {
  const summary = summaryOf(spec);
  if (spec.unavailable !== undefined) {
    return {
      ...summary,
      qualification: { state: "not-ready", checkedAt: OBSERVATION.checkedAt },
      capabilities: [],
      unavailable: spec.unavailable,
    };
  }
  const supportedModels =
    spec.models === undefined
      ? undefined
      : spec.models === "free-text"
        ? ({ kind: "free-text" } as const)
        : ({ kind: "list", models: spec.models } as const);
  return {
    ...summary,
    qualification: { state: "qualified", observation: OBSERVATION },
    ...(supportedModels === undefined ? {} : { supportedModels }),
    capabilities: [],
    configurationPosture: "Harness-owned settings stay with the Harness.",
  };
}

/** A fake `harness-catalog` view whose list is spawn-free and whose focus records
 *  every qualified id, so a test can assert that opening the step spawns nothing
 *  and choosing a Harness qualifies only that one. */
function harnessCatalog(specs: readonly HarnessSpec[]): {
  view: HarnessCatalogView;
  focusCalls: string[];
} {
  const focusCalls: string[] = [];
  const [list] = createSignal<HarnessCatalogSnapshot>({
    family: "harness-catalog",
    view: "list",
    harnesses: specs.map(summaryOf),
  });
  const view: HarnessCatalogView = {
    openList: () => list,
    openFocus: (selector: HarnessFocusSelector) => {
      focusCalls.push(selector.id);
      const spec = specs.find((candidate) => candidate.id === selector.id);
      const [snapshot] = createSignal<HarnessFocusSnapshot>({
        family: "harness-catalog",
        view: "focus",
        selection: selector,
        result:
          spec !== undefined
            ? { found: true, harness: focusOf(spec) }
            : {
                found: false,
                problem: {
                  code: "harness-not-registered",
                  explanation: "gone",
                  remediation: "register",
                  possibleEffects: "none",
                },
              },
      });
      return snapshot;
    },
  };
  return { view, focusCalls };
}

const AVAILABLE_HARNESSES: readonly HarnessSpec[] = [
  { id: "claude-code", name: "Claude Code", models: ["claude-sonnet"] },
  { id: "codex", name: "Codex", models: ["gpt-5-codex", "gpt-5"] },
];

function defaultHarnessCatalog(): HarnessCatalogView {
  return harnessCatalog(AVAILABLE_HARNESSES).view;
}

// --- hand-driven launch seam -----------------------------------------------

function fakeLaunch() {
  const calls: LaunchRunInput[] = [];
  const [outcome, setOutcome] = createSignal<LaunchOutcome>({
    kind: "pending",
  });
  const view: RunLaunchView = {
    launch(input) {
      calls.push(input);
      return outcome;
    },
  };
  return { view, calls, resolve: (o: LaunchOutcome) => setOutcome(() => o) };
}

function preparation(status: LaunchPreparationSnapshot["status"] = "ready") {
  const view: LaunchPreparationView = {
    open(draft) {
      const actionOffers: LaunchPreparationSnapshot["actionOffers"] =
        status === "ready"
          ? [
              {
                action: "launch-run",
                draft,
                trustRequired: draft.trustDigest !== undefined,
                consequence: "Create and start a Run.",
              },
            ]
          : [];
      const [snapshot] = createSignal<LaunchPreparationSnapshot>({
        family: "launch-preparation",
        status,
        draft: {
          bundle: { id: draft.bundle.id, version: draft.bundle.version },
          harness: draft.harness,
          requestedModel: draft.requestedModel,
          launchInputs: draft.launchInputs,
          trustDigest: draft.trustDigest,
        },
        findings: [],
        actionOffers,
      });
      return snapshot;
    },
  };
  return view;
}

function controlledPreparation() {
  let updateSnapshot:
    ((snapshot: LaunchPreparationSnapshot) => void) | undefined;
  let openedDraft: LaunchRunInput | undefined;
  const view: LaunchPreparationView = {
    open(draft) {
      openedDraft = draft;
      const [snapshot, setSnapshot] = createSignal<LaunchPreparationSnapshot>({
        family: "launch-preparation",
        status: "assessing",
        draft: {
          bundle: { id: draft.bundle.id, version: draft.bundle.version },
          harness: draft.harness,
          requestedModel: draft.requestedModel,
          launchInputs: draft.launchInputs,
          trustDigest: draft.trustDigest,
        },
        findings: [],
        actionOffers: [],
      });
      updateSnapshot = (next) => setSnapshot(() => next);
      return snapshot;
    },
  };
  const settle = (
    status: "ready" | "not-ready",
    findings: readonly Problem[],
  ) => {
    if (openedDraft === undefined || updateSnapshot === undefined) {
      throw new Error("Review must open preparation before it can settle");
    }
    const actionOffers: LaunchPreparationSnapshot["actionOffers"] =
      status === "ready"
        ? [
            {
              action: "launch-run",
              draft: openedDraft,
              trustRequired: openedDraft.trustDigest !== undefined,
              consequence: "Create and start a Run.",
            },
          ]
        : [];
    updateSnapshot({
      family: "launch-preparation",
      status,
      draft: {
        bundle: {
          id: openedDraft.bundle.id,
          version: openedDraft.bundle.version,
          digest: "alpha0000",
          name: "Alpha",
        },
        harness: openedDraft.harness,
        requestedModel: openedDraft.requestedModel,
        launchInputs: openedDraft.launchInputs,
        trustDigest: openedDraft.trustDigest,
      },
      findings,
      executionSummary: ALPHA.executionSummary,
      actionOffers,
    });
  };
  return { view, settle };
}

function readyPreparationFor(
  bundle: InstalledBundleFocus,
): LaunchPreparationView {
  return {
    open(draft) {
      const [snapshot] = createSignal<LaunchPreparationSnapshot>({
        family: "launch-preparation",
        status: "ready",
        draft: {
          bundle: {
            id: bundle.id,
            version: bundle.version,
            digest: bundle.digest,
            name: bundle.name,
          },
          harness: draft.harness,
          requestedModel: draft.requestedModel,
          launchInputs: draft.launchInputs,
          trustDigest: draft.trustDigest,
        },
        findings: [],
        executionSummary: bundle.executionSummary,
        actionOffers: [
          {
            action: "launch-run",
            draft,
            trustRequired: draft.trustDigest !== undefined,
            consequence: "Create and start a Run.",
          },
        ],
      });
      return snapshot;
    },
  };
}

function trustPreparation(bundle: InstalledBundleFocus): LaunchPreparationView {
  return {
    open(draft) {
      const acknowledged = draft.trustDigest === bundle.digest;
      const findings: readonly Problem[] = acknowledged
        ? []
        : [
            {
              code: "bundle-trust-required",
              explanation: "Trust acknowledgement is required.",
              remediation: "Acknowledge this exact Bundle digest.",
              possibleEffects: "none",
              correction: "trust",
            },
          ];
      const actionOffers: LaunchPreparationSnapshot["actionOffers"] =
        acknowledged
          ? [
              {
                action: "launch-run",
                draft,
                trustRequired: true,
                consequence: "Create and start a Run.",
              },
            ]
          : [];
      const [snapshot] = createSignal<LaunchPreparationSnapshot>({
        family: "launch-preparation",
        status: acknowledged ? "ready" : "not-ready",
        draft: {
          bundle: {
            id: bundle.id,
            version: bundle.version,
            digest: bundle.digest,
            name: bundle.name,
          },
          harness: draft.harness,
          requestedModel: draft.requestedModel,
          launchInputs: draft.launchInputs,
          trustDigest: draft.trustDigest,
        },
        findings,
        executionSummary: bundle.executionSummary,
        actionOffers,
      });
      return snapshot;
    },
  };
}

// The Run Workbench opens only after a successful launch; most flow tests never
// get there. This stub throws if opened, so a stray transition is caught.
function noRunView(): RunWorkbenchView {
  return {
    openRun() {
      throw new Error("run workbench not opened in this test");
    },
    readResource() {
      throw new Error("run workbench not opened in this test");
    },
    readTranscript() {
      throw new Error("run workbench not opened in this test");
    },
    answer() {
      throw new Error("run workbench not opened in this test");
    },
    sendInteractiveTurn() {
      throw new Error("run workbench not opened in this test");
    },
    endInteractiveStep() {
      throw new Error("run workbench not opened in this test");
    },
    continueRepeat() {
      throw new Error("run workbench not opened in this test");
    },
    steer() {
      throw new Error("run workbench not opened in this test");
    },
    answerText() {
      throw new Error("run workbench not opened in this test");
    },
    answerRequest() {
      throw new Error("run workbench not opened in this test");
    },
  };
}

// A Run Workbench seam that serves any requested Run id as a resting, succeeded
// Run, so the receipt-replacement tests can assert the transition into it (#91).
function succeedingRunView(): RunWorkbenchView {
  return {
    openRun(runId) {
      const [snapshot] = createSignal<RunSnapshot>({
        family: "run",
        runId,
        result: {
          found: true,
          run: {
            runId,
            bundle: {
              id: "dev.alpha",
              version: "1.0.0",
              name: "Alpha",
              digest: "d",
            },
            workspacePath: WORKSPACE,
            launchedAt: "2026-01-01T00:00:00.000Z",
            state: "succeeded",
            liveness: { state: "not-live" },
            progress: [],
            position: 0,
            timeline: [],
            outputs: [],
            actionOffers: [],
          },
        },
      });
      return {
        snapshot,
        live: () => undefined,
        preview: () => undefined,
        freshness: () => ({
          kind: "current",
          catchUp: "fresh",
          lastConfirmedAt: "2026-09-22T10:30:00.000Z",
        }),
        reconnect() {},
      };
    },
    readResource() {
      throw new Error("no reference read in this test");
    },
    readTranscript() {
      throw new Error("no transcript read in this test");
    },
    answer() {
      throw new Error("no answer dispatched in this test");
    },
    sendInteractiveTurn() {
      throw new Error("no interactive Turn sent in this test");
    },
    endInteractiveStep() {
      throw new Error("no interactive Step ended in this test");
    },
    continueRepeat() {
      throw new Error("no interactive Step ended in this test");
    },
    steer() {
      throw new Error("no steer dispatched in this test");
    },
    answerText() {
      throw new Error("no answer dispatched in this test");
    },
    answerRequest() {
      throw new Error("no answer dispatched in this test");
    },
  };
}

async function mountFlow(
  bundlesView: BundleCatalogView,
  launchView: RunLaunchView,
  width = 100,
  height = 40,
  runView: RunWorkbenchView = noRunView(),
  harnessesView: HarnessCatalogView = defaultHarnessCatalog(),
  preparationView: LaunchPreparationView = preparation(),
) {
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={bundlesView}
        harnesses={harnessesView}
        preparation={preparationView}
        launch={launchView}
        run={runView}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer(width, height).port}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width, height },
  );
  await t.waitForFrame((f) => f.includes("Secant"));
  // Start a Run is the first and default Home entry (#191), so Enter opens it.
  t.mockInput.pressEnter();
  // "esc back" is in every chooser footer but not Home's, so it marks arrival.
  await t.waitForFrame((f) => f.includes("esc back"));
  return { t, exits };
}

const ALPHA = focus({
  id: "dev.alpha",
  name: "Alpha",
  description: "The trusted one",
  digest: "alpha0000",
  trust: { state: "app-release" },
  launchInputs: [],
});
const AGENT_ALPHA = focus({
  id: "dev.agent-alpha",
  name: "Agent Alpha",
  description: "The agent-bearing one",
  digest: "agentalpha000",
  trust: { state: "app-release" },
  launchInputs: [],
  routing: [{ node: "step", step: { id: "work", kind: "agent" } }],
});
const BETA = focus({
  id: "dev.beta",
  name: "Beta",
  description: "The untrusted one",
  digest: "beta1111",
  trust: { state: "not-yet-trusted" },
  launchInputs: [
    { name: "target", type: "text", description: "What to build" },
    {
      name: "mode",
      type: "choice",
      description: "How to run",
      choices: ["fast", "slow"],
    },
  ],
});
const AGENT_BETA = focus({
  id: "dev.agent-beta",
  name: "Agent Beta",
  description: "An agent Bundle with draft input.",
  digest: "agentbeta111",
  trust: { state: "app-release" },
  launchInputs: [
    { name: "target", type: "text", description: "What to build" },
  ],
  routing: [{ node: "step", step: { id: "work", kind: "agent" } }],
});
const UNTRUSTED_AGENT_BETA = focus({
  id: "dev.untrusted-agent-beta",
  name: "Untrusted Agent Beta",
  description: "An untrusted agent Bundle with one input.",
  digest: "untrustedagentbeta111",
  trust: { state: "not-yet-trusted" },
  launchInputs: [
    { name: "target", type: "text", description: "What to build" },
  ],
  routing: [{ node: "step", step: { id: "work", kind: "agent" } }],
});

// Two trusted Bundles that both declare an input named `target`, for the
// cross-Bundle draft-leak test.
const GAMMA = focus({
  id: "dev.gamma",
  name: "Gamma",
  description: "trusted one",
  digest: "gamma000",
  trust: { state: "app-release" },
  launchInputs: [{ name: "target", type: "text", description: "for gamma" }],
});
const DELTA = focus({
  id: "dev.delta",
  name: "Delta",
  description: "trusted two",
  digest: "delta000",
  trust: { state: "app-release" },
  launchInputs: [{ name: "target", type: "text", description: "for delta" }],
});
// A second untrusted Bundle, for the acknowledgement-persistence test.
const EPSILON = focus({
  id: "dev.epsilon",
  name: "Epsilon",
  description: "untrusted two",
  digest: "eps22222",
  trust: { state: "not-yet-trusted" },
  launchInputs: [],
});

// --- chooser + trust -------------------------------------------------------

test("chooser lists Bundles with the side panel; untrusted shows the acknowledgement, trusted does not; Continue is gated", async () => {
  const { t } = await mountFlow(catalog([ALPHA, BETA]), fakeLaunch().view);
  const first = t.captureCharFrame();
  // Side panel limited to Name, Description, Source, Workflow.
  assert.match(first, /Name/);
  assert.match(first, /The trusted one/);
  assert.match(first, /Source/);
  assert.match(first, /Workflow/);
  assert.match(first, /build \(command\)/);
  // Trusted selection: no acknowledgement, Continue available.
  assert.doesNotMatch(first, /acknowledge/i);
  assert.match(first, /enter continue/);

  // Move to the untrusted Bundle.
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => /acknowledge/i.test(f));
  const untrusted = t.captureCharFrame();
  assert.match(untrusted, /Untrusted Bundle/);
  assert.match(untrusted, /press a to acknowledge/);
  // Continue unavailable until acknowledged.
  assert.match(untrusted, /acknowledge trust \(a\) to continue/);

  // Acknowledge.
  t.mockInput.pressKey("a");
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  assert.match(t.captureCharFrame(), /enter continue/);
});

test("a Bundle with no declared inputs skips the inputs screen and reaches review, digest shown once", async () => {
  const { t } = await mountFlow(
    catalog([ALPHA]),
    fakeLaunch().view,
    100,
    40,
    noRunView(),
    defaultHarnessCatalog(),
    preparation("assessing"),
  );
  t.mockInput.pressEnter(); // Alpha is trusted + no inputs → straight to review
  await t.waitForFrame((f) => f.includes("Review"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Checking launch/);
  assert.match(frame, /No launch inputs/);
  assert.match(frame, /sha256:alpha0000/);
  assert.equal(
    frame.split("alpha0000").length - 1,
    1,
    "digest shown exactly once",
  );
});

test("[start-run-review-assessment] assessing and not-ready block Start Run; ready enables it and launch settles visibly", async () => {
  const launch = fakeLaunch();
  const assessment = controlledPreparation();
  const { t } = await mountFlow(
    catalog([ALPHA]),
    launch.view,
    100,
    40,
    noRunView(),
    defaultHarnessCatalog(),
    assessment.view,
  );
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Checking launch"));
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.equal(launch.calls.length, 0, "assessing cannot submit");

  assessment.settle("not-ready", [
    {
      code: "workspace-prerequisite-failed",
      explanation: "Workspace prerequisite not met.",
      remediation: "Launch Secant from a Git worktree root.",
      possibleEffects: "none",
      correction: "workspace",
    },
  ]);
  await t.waitForFrame((frame) => frame.includes("Workspace prerequisite"));
  const refused = t.captureCharFrame();
  assert.match(refused, /Not ready/);
  assert.match(refused, /Launch Secant from a Git worktree root/);
  assert.doesNotMatch(refused, /workspace-prerequisite-failed/);
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.equal(launch.calls.length, 0, "not-ready cannot submit");

  assessment.settle("ready", []);
  await t.waitForFrame((frame) => frame.includes("Ready to start"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Checking launch"));
  assert.equal(launch.calls.length, 1);
});

test("[start-run-review-assessment] Review renders the complete assessed draft and exact trust posture", async () => {
  const { t } = await mountFlow(
    catalog([UNTRUSTED_AGENT_BETA]),
    fakeLaunch().view,
    100,
    40,
    noRunView(),
    defaultHarnessCatalog(),
    readyPreparationFor(UNTRUSTED_AGENT_BETA),
  );
  t.mockInput.pressKey("a");
  await t.waitForFrame((frame) => frame.includes("Trust acknowledged"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Model"));
  t.mockInput.pressArrow("right");
  await t.waitForFrame((frame) => frame.includes("claude-sonnet"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Launch inputs"));
  t.mockInput.pressKey("h");
  t.mockInput.pressKey("i");
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Review"));

  const frame = t.captureCharFrame();
  assert.match(frame, /Workflow.*work \(agent\)/s);
  assert.match(frame, /Bundle.*Untrusted Agent Beta/s);
  assert.match(frame, /sha256:untrustedagentbeta111/);
  assert.match(frame, /Workspace.*secant-launch-workspace/s);
  assert.match(frame, new RegExp(WORKSPACE.replaceAll("/", "\\/")));
  assert.match(frame, /Harness: Claude Code \(claude-code\)/);
  assert.match(frame, /model claude-sonnet/);
  assert.match(frame, /target: hi/);
  assert.match(frame, /Trust: Exact digest acknowledged for this launch/);
  assert.equal(frame.split("untrustedagentbeta111").length - 1, 1);
});

test("[both-client-harness-selection] the Harness step shows worded rows, spawns nothing until a Harness is chosen, then qualifies only that one", async () => {
  const launch = fakeLaunch();
  const harnesses = harnessCatalog(AVAILABLE_HARNESSES);
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    launch.view,
    40,
    20,
    noRunView(),
    harnesses.view,
  );
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Claude Code/);
  assert.match(frame, /Codex/);
  // Worded qualification, never a raw enum, and colour-independent.
  assert.match(frame, /Not checked/);
  assert.doesNotMatch(frame, /availability/i);
  // Opening the step spawns nothing: no focus opened until a Harness is chosen.
  assert.deepEqual(harnesses.focusCalls, []);
  for (const line of frame.split("\n")) {
    assert.ok(line.length <= 40, `overflow at 40: ${JSON.stringify(line)}`);
  }

  t.mockInput.pressArrow("down"); // highlight Codex (still spawn-free)
  assert.deepEqual(harnesses.focusCalls, []);
  t.mockInput.pressEnter(); // choose Codex → qualifies only Codex
  await t.waitForFrame((candidate) => candidate.includes("Model"));
  assert.deepEqual(harnesses.focusCalls, ["codex"]);

  t.mockInput.pressEnter(); // model default → review
  await t.waitForFrame((candidate) => candidate.includes("Review"));
  assert.match(t.captureCharFrame(), /Harness: Codex \(codex\)/);

  t.mockInput.pressEnter();
  await t.waitForFrame((candidate) => candidate.includes("Checking launch"));
  assert.equal(launch.calls[0]?.harness, "codex");
  assert.equal(launch.calls[0]?.requestedModel, undefined);
});

test("changing a Harness after a selected-Harness refusal preserves unrelated input drafts", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([AGENT_BETA]), launch.view);
  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressArrow("down"); // highlight Codex
  t.mockInput.pressEnter(); // choose Codex → model phase
  await t.waitForFrame((frame) => frame.includes("Model"));
  await t.renderOnce();
  t.mockInput.pressEnter(); // model default → inputs
  await t.waitForFrame((frame) => frame.includes("Launch inputs"));
  t.mockInput.pressKey("h");
  t.mockInput.pressKey("i");
  await t.waitForFrame((frame) => frame.includes("hi"));
  t.mockInput.pressEnter(); // inputs → review
  await t.waitForFrame((frame) => frame.includes("Harness: Codex"));
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((frame) => frame.includes("Checking launch"));
  launch.resolve({
    kind: "refused",
    problem: {
      code: "harness-not-found",
      explanation: "Codex could not be found.",
      remediation: "Install Codex.",
      possibleEffects: "none",
      correction: "harness",
      details: { harness: "codex" },
    },
  });
  await t.waitForFrame((frame) => frame.includes("Codex could not be found"));
  const refused = t.captureCharFrame();
  assert.match(refused, /Run not started/);
  assert.match(refused, /enter choose/);
  assert.match(refused, /› Codex/, "the invalidated Harness receives focus");
  assert.doesNotMatch(refused, /harness-not-found/);
  t.mockInput.pressArrow("up"); // highlight Claude Code
  t.mockInput.pressEnter(); // choose Claude Code → model phase
  await t.waitForFrame((frame) => frame.includes("Model"));
  await t.renderOnce();
  t.mockInput.pressEnter(); // model default → inputs
  await t.waitForFrame((frame) => frame.includes("Launch inputs"));
  assert.match(t.captureCharFrame(), /hi/);
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Harness: Claude Code"));
  assert.match(t.captureCharFrame(), /target: hi/);
});

test("a Harness refusal preserves its model choice when the same Harness is selected again", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([AGENT_ALPHA]), launch.view);
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Model"));
  t.mockInput.pressArrow("right");
  await t.waitForFrame((frame) => frame.includes("‹ claude-sonnet ›"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Review"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Checking launch"));
  launch.resolve({
    kind: "refused",
    problem: {
      code: "harness-not-ready",
      explanation: "Claude Code is no longer ready.",
      remediation: "Authenticate Claude Code or choose another Harness.",
      possibleEffects: "none",
      correction: "harness",
    },
  });

  await t.waitForFrame((frame) => frame.includes("no longer ready"));
  assert.match(t.captureCharFrame(), /› Claude Code/);
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Model"));
  assert.match(t.captureCharFrame(), /‹ claude-sonnet ›/);
});

test("a model refusal keeps the Harness and inputs but clears only the requested model", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([AGENT_BETA]), launch.view);
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Model"));
  t.mockInput.pressArrow("right");
  await t.waitForFrame((frame) => frame.includes("‹ claude-sonnet ›"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Launch inputs"));
  t.mockInput.pressKey("h");
  t.mockInput.pressKey("i");
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Review"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Checking launch"));
  launch.resolve({
    kind: "refused",
    problem: {
      code: "requested-model-unavailable",
      explanation: "The selected model is no longer available.",
      remediation: "Choose a currently supported model.",
      possibleEffects: "none",
      correction: "model",
    },
  });

  await t.waitForFrame((frame) => frame.includes("selected model"));
  const model = t.captureCharFrame();
  assert.match(model, /Harness: Claude Code/);
  assert.match(model, /‹ Harness default ›/);
  assert.match(model, /Run not started/);
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Launch inputs"));
  assert.match(t.captureCharFrame(), /hi/);
});

test("an unavailable Harness names its reason and remediation, cannot continue, and relayouts after resize", async () => {
  const harnesses = harnessCatalog([
    { id: "claude-code", name: "Claude Code", models: ["claude-sonnet"] },
    {
      id: "codex",
      name: "Codex",
      notFound: true,
      unavailable: {
        code: "harness-not-ready",
        explanation: "Codex support is disabled in this build.",
        remediation: "Enable Codex, or choose another Harness.",
        possibleEffects: "none",
      },
    },
  ]);
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    fakeLaunch().view,
    50,
    20,
    noRunView(),
    harnesses.view,
  );
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  // Availability is visible in words before focusing the unavailable Harness.
  assert.match(t.captureCharFrame(), /Unavailable · not found on/);
  t.mockInput.pressArrow("down"); // highlight Codex
  t.mockInput.pressEnter(); // choose Codex → its focus is unavailable
  await t.waitForFrame((frame) => frame.includes("Codex support is disabled"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Codex support is disabled/);
  assert.match(frame, /Enable Codex/);
  t.mockInput.pressEnter(); // cannot continue while unavailable
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Choose a Harness/);
  assert.doesNotMatch(t.captureCharFrame(), /Review/);
  t.resize(30, 20);
  await t.renderOnce();
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(line.length <= 30, `overflow at 30: ${JSON.stringify(line)}`);
  }
});

test("[start-run-model-choice] a list Harness offers Harness default first then its models, and the draft carries the chosen model", async () => {
  const launch = fakeLaunch();
  const harnesses = harnessCatalog([
    {
      id: "claude-code",
      name: "Claude Code",
      models: ["claude-sonnet", "claude-opus"],
    },
    { id: "codex", name: "Codex", models: "free-text" },
  ]);
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    launch.view,
    100,
    40,
    noRunView(),
    harnesses.view,
  );
  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  assert.deepEqual(harnesses.focusCalls, []); // spawn-free until chosen
  t.mockInput.pressEnter(); // choose Claude Code (highlighted first)
  await t.waitForFrame((frame) => frame.includes("Model"));
  assert.deepEqual(harnesses.focusCalls, ["claude-code"]);
  const model = t.captureCharFrame();
  // Harness default is the first option and the models follow it.
  assert.match(model, /Harness default/);
  assert.match(model, /claude-sonnet, claude-opus/);

  t.mockInput.pressArrow("right"); // Harness default → claude-sonnet
  await t.waitForFrame((frame) => /‹ claude-sonnet ›/.test(frame));
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((frame) => frame.includes("Review"));
  assert.match(t.captureCharFrame(), /model claude-sonnet/);
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((frame) => frame.includes("Checking launch"));
  assert.equal(launch.calls[0]?.requestedModel, "claude-sonnet");
});

test("[start-run-model-choice] a free-text Harness accepts a typed model, and blank means Harness default", async () => {
  const launch = fakeLaunch();
  const harnesses = harnessCatalog([
    { id: "codex", name: "Codex", models: "free-text" },
  ]);
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    launch.view,
    100,
    40,
    noRunView(),
    harnesses.view,
  );
  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressEnter(); // choose the only Harness → model phase
  await t.waitForFrame((frame) =>
    frame.includes("Leave blank for Harness default"),
  );
  // Type a free-text model, then a trailing space: the stored model is trimmed so
  // Preflight (which matches the model verbatim) never sees stray whitespace.
  t.mockInput.pressKey("o");
  t.mockInput.pressKey("4");
  t.mockInput.pressKey(" ");
  await t.waitForFrame((frame) => frame.includes("o4"));
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((frame) => frame.includes("Review"));
  assert.match(t.captureCharFrame(), /model o4/);
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((frame) => frame.includes("Checking launch"));
  assert.equal(launch.calls[0]?.requestedModel, "o4");
});

test("a Command-only Bundle asks for neither Harness nor model and numbers its steps N of M", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([ALPHA]), launch.view);
  // Command-only ALPHA has no inputs, so the sequence is Bundle → Review: 1 of 2.
  assert.match(t.captureCharFrame(), /Step 1 of 2/);
  t.mockInput.pressEnter(); // straight to review (no Harness, no inputs)
  await t.waitForFrame((f) => f.includes("Review"));
  const review = t.captureCharFrame();
  assert.match(review, /Step 2 of 2/);
  assert.doesNotMatch(review, /Harness:/); // no Harness/model for a Command-only Bundle
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Checking launch"));
  assert.equal(launch.calls[0]?.harness, undefined);
  assert.equal(launch.calls[0]?.requestedModel, undefined);
});

test("an Agent Bundle with inputs numbers Bundle, Harness, Inputs, Review as N of 4", async () => {
  const { t } = await mountFlow(catalog([AGENT_BETA]), fakeLaunch().view);
  assert.match(t.captureCharFrame(), /Step 1 of 4/); // Bundle
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Choose a Harness"));
  assert.match(t.captureCharFrame(), /Step 2 of 4/); // Harness
  t.mockInput.pressEnter(); // choose Claude Code → model
  await t.waitForFrame((f) => f.includes("esc choose another"));
  t.mockInput.pressEnter(); // → inputs
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  assert.match(t.captureCharFrame(), /Step 3 of 4/); // Inputs
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  assert.match(t.captureCharFrame(), /Step 4 of 4/); // Review
});

test("pending feedback then a transition into the Workbench for the Run id; a trusted launch carries no trustDigest", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([ALPHA]),
    launch.view,
    100,
    40,
    succeedingRunView(),
  );
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Checking launch"));
  assert.equal(launch.calls.length, 1);
  assert.equal(launch.calls[0]?.trustDigest, undefined);

  // A successful launch replaces #90's receipt with the Run's Workbench (#91).
  launch.resolve({ kind: "launched", runId: "run-42", state: "succeeded" });
  await t.waitForFrame((f) => f.includes("Run run-42"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Run run-42/);
  assert.match(frame, /SUCCEEDED/); // state in words as well as colour
  assert.match(frame, /Timeline/); // timeline-first Workbench
});

// --- typed inputs + inline findings ---------------------------------------

test("renders exactly the declared inputs, carries the acknowledged trustDigest, and shows per-input findings inline after Start", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([BETA]), launch.view);
  t.mockInput.pressKey("a"); // acknowledge trust (BETA is the only, selected, Bundle)
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressEnter(); // → inputs (BETA has inputs)
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  const inputs = t.captureCharFrame();
  assert.match(inputs, /target \(text\)/);
  assert.match(inputs, /mode \(choice\)/);

  // Type into the focused text input, then cycle the choice input.
  t.mockInput.pressKey("h");
  t.mockInput.pressKey("i");
  await t.waitForFrame((f) => f.includes("hi"));
  t.mockInput.pressArrow("down"); // focus the choice input
  t.mockInput.pressArrow("right"); // choose "fast"
  await t.waitForFrame((f) => /‹ fast ›/.test(f));

  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  const review = t.captureCharFrame();
  assert.match(review, /target: hi/);
  assert.match(review, /mode: fast/);

  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Checking launch"));
  assert.equal(
    launch.calls[0]?.trustDigest,
    "beta1111",
    "acknowledged digest is sent",
  );
  assert.deepEqual(launch.calls[0]?.launchInputs, {
    target: "hi",
    mode: "fast",
  });

  // Refuse with a per-input violation: route back to inputs with the finding,
  // and the drafts stay intact.
  launch.resolve({
    kind: "refused",
    problem: {
      code: "launch-input-invalid",
      explanation: "invalid",
      remediation: "fix",
      possibleEffects: "none",
      correction: "inputs",
      fieldViolations: [
        { field: "target", explanation: "must be non-empty text." },
      ],
    },
  });
  await t.waitForFrame((f) => f.includes("must be non-empty text."));
  const refused = t.captureCharFrame();
  assert.match(refused, /Launch inputs/);
  assert.match(refused, /Run not started · ctrl\+d dismiss/);
  assert.match(refused, /must be non-empty text\./);
  assert.match(refused, /› target/, "the invalidated field receives focus");
  assert.doesNotMatch(refused, /hi/, "the invalidated input is cleared");

  // A printable `d` still reaches the focused input while the notice is present.
  t.mockInput.pressKey("d");
  await t.waitForFrame((frame) => frame.includes("d"));
  assert.match(t.captureCharFrame(), /Run not started/);
  t.mockInput.pressBackspace();
  // Dismissing the notice never removes the inline finding.
  t.mockInput.pressKey("d", { ctrl: true });
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /Run not started/);
  assert.match(t.captureCharFrame(), /must be non-empty text\./);
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Review"));
  const preserved = t.captureCharFrame();
  assert.match(preserved, /target:/);
  assert.doesNotMatch(preserved, /target: hi/);
  assert.match(preserved, /mode: fast/);
});

test("an input draft does not leak into another Bundle's same-named input", async () => {
  const { t } = await mountFlow(catalog([GAMMA, DELTA]), fakeLaunch().view);
  t.mockInput.pressEnter(); // Gamma (trusted) → inputs
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  t.mockInput.pressKey("h");
  t.mockInput.pressKey("i");
  await t.waitForFrame((f) => f.includes("hi"));
  t.mockInput.pressEscape(); // back to the chooser
  await until(() => !t.captureCharFrame().includes("Launch inputs"));
  t.mockInput.pressArrow("down"); // select Delta (also declares `target`)
  t.mockInput.pressEnter(); // → inputs
  await until(() => t.captureCharFrame().includes("for delta"));
  // Delta's `target` starts empty — Gamma's draft did not leak in.
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  assert.match(t.captureCharFrame(), /target: \(not set\)/);
});

test("an acknowledged digest stays acknowledged after visiting another Bundle", async () => {
  const { t } = await mountFlow(catalog([BETA, EPSILON]), fakeLaunch().view);
  t.mockInput.pressKey("a"); // acknowledge Beta
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressArrow("down"); // Epsilon (also untrusted)
  await t.waitForFrame((f) => f.includes("untrusted two"));
  t.mockInput.pressKey("a"); // acknowledge Epsilon too
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressArrow("up"); // back to Beta
  await t.waitForFrame((f) => f.includes("The untrusted one"));
  // Beta is still acknowledged — the set kept it.
  assert.match(t.captureCharFrame(), /Trust acknowledged/);
  assert.match(t.captureCharFrame(), /enter continue/);
});

test("an empty Catalog shows no acknowledge hint", async () => {
  const { t } = await mountFlow(catalog([]), fakeLaunch().view);
  const frame = t.captureCharFrame();
  assert.match(frame, /Catalog is empty/);
  assert.doesNotMatch(frame, /acknowledge/i);
});

// --- refusals routed to their owning step ---------------------------------

async function refuseFromReview(problem: Problem) {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([ALPHA]), launch.view);
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Checking launch"));
  launch.resolve({ kind: "refused", problem });
  return t;
}

test("a Workspace prerequisite failure returns to Bundle selection with the remediation", async () => {
  const t = await refuseFromReview({
    code: "workspace-prerequisite-failed",
    explanation: "The Workspace is not a Git worktree root.",
    remediation:
      "Launch from the root of a Git worktree, or choose another Bundle.",
    possibleEffects: "none",
    correction: "workspace",
  });
  await t.waitForFrame((f) => f.includes("not a Git worktree root"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Start a Run/); // back on the chooser
  assert.match(frame, /Run not started/);
  assert.doesNotMatch(frame, /workspace-prerequisite-failed/);
  assert.match(frame, /choose another Bundle/);
  assert.doesNotMatch(frame, /Timeline/); // never transitioned into the Workbench
});

test("a corrupted Bundle returns to selection advising reinstalling it", async () => {
  const t = await refuseFromReview({
    code: "bundle-snapshot-corrupt",
    explanation:
      "The installed Bundle is corrupted and can no longer be launched.",
    remediation:
      "Reinstall the Bundle to restore an intact copy, then launch again.",
    possibleEffects: "none",
    correction: "bundle",
  });
  await t.waitForFrame((f) => f.includes("installed Bundle is corrupted"));
  const frame = t.captureCharFrame();
  assert.match(frame, /corrupted/);
  assert.match(frame, /Reinstall the Bundle/);
  assert.doesNotMatch(frame, /Timeline/); // never transitioned into the Workbench
});

test("a Command refusal routes to Bundle selection without exposing its code", async () => {
  const t = await refuseFromReview({
    code: "command-executable-not-found",
    explanation: "A required command is no longer available.",
    remediation: "Install the command, or choose another Bundle.",
    possibleEffects: "none",
    correction: "command",
  });
  await t.waitForFrame((frame) => frame.includes("required command"));
  const refused = t.captureCharFrame();
  assert.match(refused, /Start a Run/);
  assert.match(refused, /Run not started/);
  assert.doesNotMatch(refused, /command-executable-not-found/);
});

test("a trust refusal returns to Review and requires acknowledgement of the exact digest again", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([BETA]),
    launch.view,
    40,
    20,
    noRunView(),
    defaultHarnessCatalog(),
    trustPreparation(BETA),
  );
  t.mockInput.pressKey("a");
  await t.renderOnce();
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Launch inputs"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Ready to start"));
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Checking launch"));
  launch.resolve({
    kind: "refused",
    problem: {
      code: "bundle-trust-required",
      explanation: "Trust acknowledgement is required.",
      remediation: "Acknowledge this exact Bundle digest.",
      possibleEffects: "none",
      correction: "trust",
    },
  });

  await t.waitForFrame((frame) =>
    frame.includes("Trust acknowledgement is required"),
  );
  const refused = t.captureCharFrame();
  assert.match(refused, /Review/);
  assert.match(refused, /Not ready/);
  assert.match(refused, /Run not started/);
  assert.match(refused, /Trust: Acknowledgement required/);
  assert.doesNotMatch(refused, /bundle-trust-required/);
  for (const line of refused.split("\n")) {
    assert.ok(line.length <= 40, `overflow at 40: ${JSON.stringify(line)}`);
  }
  t.mockInput.pressKey("a");
  await t.waitForFrame((frame) => frame.includes("Ready to start"));
  assert.match(t.captureCharFrame(), /Exact digest acknowledged/);
});

test("declining trust launches nothing and cannot continue", async () => {
  const launch = fakeLaunch();
  const { t, exits } = await mountFlow(catalog([BETA]), launch.view);
  // Do not acknowledge; Continue must be unavailable.
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /acknowledge trust \(a\) to continue/);
  assert.equal(launch.calls.length, 0, "no launch was submitted");

  // Escape declines: back to Home, still nothing launched.
  t.mockInput.pressEscape();
  await until(() => t.captureCharFrame().includes("Workspace"));
  assert.match(t.captureCharFrame(), /Secant/);
  assert.equal(launch.calls.length, 0);
  assert.deepEqual(exits, []);
});

test("Escape steps back one screen at a time", async () => {
  const { t } = await mountFlow(catalog([BETA]), fakeLaunch().view);
  t.mockInput.pressKey("a");
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressEnter(); // → inputs
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  t.mockInput.pressEscape(); // inputs → choose
  await until(() => !t.captureCharFrame().includes("Launch inputs"));
  assert.match(t.captureCharFrame(), /enter continue/); // back on the chooser
  t.mockInput.pressEscape(); // choose → home
  await until(() => t.captureCharFrame().includes("Workspace"));
  assert.match(t.captureCharFrame(), /enter open/); // Home footer
});

// --- layout ----------------------------------------------------------------

function lineWith(frame: string, needle: string): string {
  return frame.split("\n").find((line) => line.includes(needle)) ?? "";
}

test("wide width places the side panel beside the list; a small width collapses it below, both without horizontal overflow", async () => {
  const { t } = await mountFlow(
    catalog([ALPHA, BETA]),
    fakeLaunch().view,
    100,
    30,
  );
  // Row layout: the panel's "Name" shares a line with the "Alpha" list row.
  assert.ok(lineWith(t.captureCharFrame(), "Alpha").includes("Name"));

  t.resize(40, 30);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  for (const line of narrow.split("\n")) {
    assert.ok(line.length <= 40, `overflow at 40: ${JSON.stringify(line)}`);
  }
  // Collapsed: the panel is now below the list — "Name" no longer shares the
  // "Alpha" row, and both are still present.
  assert.match(narrow, /Alpha/);
  assert.match(narrow, /Name/);
  assert.ok(
    !lineWith(narrow, "Alpha").includes("Name"),
    "side panel dropped below the list",
  );

  t.resize(30, 30);
  await t.renderOnce();
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(line.length <= 30, `overflow at 30: ${JSON.stringify(line)}`);
  }
});

// --- live launch seam over fake operation/run snapshots --------------------

function stubProjection(snapshot: unknown): OpenedProjection {
  return {
    snapshot,
    catchUp: "fresh",
    updates: (async function* () {})(),
    close() {},
  } as OpenedProjection;
}

/** A fake Port that answers submit with a fixed admission and serves the
 *  `operation`/`run` snapshots the launch sequence reads. */
function fakePort(config: {
  admission: SubmissionAdmission;
  operation?: OperationSnapshot;
  run?: RunSnapshot;
  onSubmit?: (submission: Submission) => void;
}): ProjectionPort {
  const openProjection = (selector: ProjectionSelector): OpenedProjection => {
    if (selector.family === "operation")
      return stubProjection(config.operation);
    if (selector.family === "run") return stubProjection(config.run);
    throw new Error(`unexpected selector ${selector.family}`);
  };
  return {
    openProjection: openProjection as ProjectionPort["openProjection"],
    submit(submission: Submission): SubmissionAdmission {
      config.onSubmit?.(submission);
      return config.admission;
    },
    readResource() {
      throw new Error("not used");
    },
    readTranscript() {
      throw new Error("not used");
    },
  };
}

const RUN_SUCCEEDED: RunSnapshot = {
  family: "run",
  runId: "run-9",
  result: {
    found: true,
    run: {
      runId: "run-9",
      bundle: { id: "x", version: "1.0.0", name: "X", digest: "d" },
      workspacePath: WORKSPACE,
      launchedAt: "2026-01-01T00:00:00.000Z",
      state: "succeeded",
      liveness: { state: "not-live" },
      progress: [],
      position: 0,
      timeline: [],
      outputs: [],
      actionOffers: [],
    },
  },
};

test("live seam: submit → applied operation → found Run yields a launched receipt", () => {
  let sent: Submission | undefined;
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    operation: {
      family: "operation",
      operationId: "op-1",
      outcome: { status: "applied" },
    },
    run: RUN_SUCCEEDED,
    onSubmit: (s) => (sent = s),
  });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, {
    kind: "launched",
    runId: "run-9",
    state: "succeeded",
  });
  assert.equal(sent?.operation, "launch-run");
});

test("live seam: a not-admitted submission is a refusal", () => {
  const problem: Problem = {
    code: "workspace-not-approved",
    explanation: "no",
    remediation: "approve",
    possibleEffects: "none",
  };
  const port = fakePort({ admission: { admitted: false, problem } });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, { kind: "refused", problem });
});

test("live seam: launch resolves at admission from the running Run, without reading the operation outcome", () => {
  // The operation is still `pending` (settlement is deferred now, #98). The launch
  // must resolve at admission from the live `run` snapshot — never blocking on the
  // operation outcome — so the flow reaches the Workbench before the Run rests (S1).
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    operation: {
      family: "operation",
      operationId: "op-1",
      outcome: { status: "pending" },
    },
    run: {
      family: "run",
      runId: "run-9",
      result: {
        found: true,
        run: {
          runId: "run-9",
          bundle: { id: "x", version: "1.0.0", name: "X", digest: "d" },
          workspacePath: WORKSPACE,
          launchedAt: "2026-01-01T00:00:00.000Z",
          state: "running",
          liveness: { state: "live-here", ownerPid: 123 },
          progress: [],
          position: 0,
          timeline: [],
          outputs: [],
          actionOffers: [],
        },
      },
    },
  });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, {
    kind: "launched",
    runId: "run-9",
    state: "running",
  });
});

test("live seam: an admitted launch whose Run cannot be read is a refusal", () => {
  const problem: Problem = {
    code: "run-store-damaged",
    explanation: "bad",
    remediation: "fix",
    possibleEffects: "none",
  };
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    run: { family: "run", runId: "run-9", result: { found: false, problem } },
  });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, { kind: "refused", problem });
});

test("live seam: an admitted launch with no Run id is a contract-breach refusal", () => {
  const port = fakePort({ admission: { admitted: true, operationId: "op-1" } });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.equal(outcome.kind, "refused");
  assert.equal(
    outcome.kind === "refused" ? outcome.problem.code : "",
    "run-not-identified",
  );
});

test("end-to-end over the live seam: a launched Run transitions into its Workbench", async () => {
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    operation: {
      family: "operation",
      operationId: "op-1",
      outcome: { status: "applied" },
    },
    run: RUN_SUCCEEDED,
  });
  const { t } = await mountFlow(
    catalog([ALPHA]),
    createLiveRunLaunchView(port),
    100,
    40,
    succeedingRunView(),
  );
  t.mockInput.pressEnter(); // Alpha is trusted + no inputs → review
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Run run-9"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Run run-9/);
  assert.match(frame, /SUCCEEDED/);
});
