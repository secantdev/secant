import assert from "node:assert/strict";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import type {
  BundleCatalogSnapshot,
  HarnessCatalogSnapshot,
  HarnessFocus,
  HarnessFocusSelector,
  HarnessFocusSnapshot,
  HarnessSummary,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";
import { App } from "../../src/tui/tui.js";
import type {
  BundleCatalogView,
  RunLaunchView,
  RunWorkbenchView,
  WorkspaceView,
} from "../../src/tui/tui.js";
import {
  inertLaunchPreparationView,
  inertRunActionsView,
  inertRunListView,
} from "./inert.js";
import { makeFakeRenderer, until } from "./renderer-fixture.js";

const QUALIFIED_CODEX: HarnessFocus = {
  id: "codex",
  name: "Codex",
  discovery: {
    state: "found",
    source: "path",
    description: "PATH name 'codex'",
  },
  qualification: {
    state: "qualified-with-limits",
    observation: {
      executable: "PATH name 'codex' -> /tools/codex",
      executableVersion: "1.2.3",
      platform: "linux",
      checkedAt: "2026-09-22T00:00:00.000Z",
    },
  },
  supportedModels: { kind: "list", models: ["gpt-5", "gpt-5-mini"] },
  capabilities: [
    {
      capability: "session-recovery",
      name: "Session recovery",
      description: "Resume a Harness Session after process loss.",
      state: "available-with-limits",
      limits: "Reloads retained history before live activity.",
    },
    {
      capability: "same-turn-steering",
      name: "Same-Turn steering",
      description: "Send guidance while the current Turn is still working.",
      state: "unavailable",
    },
    {
      capability: "turn-interruption",
      name: "Turn interruption",
      description: "Stop the current Turn and its native work.",
      state: "available",
    },
    {
      capability: "tool-approvals",
      name: "Tool approvals",
      description: "Review tool actions raised by the Harness.",
      state: "available",
    },
    {
      capability: "structured-questions",
      name: "Structured questions",
      description: "Answer structured questions raised by the Harness.",
      state: "not-checked",
    },
    {
      capability: "effective-model",
      name: "Effective model",
      description: "Observe the model that actually served a Turn.",
      state: "available",
    },
  ],
  configurationPosture: "Uses the user's existing Codex configuration.",
};

const UNAVAILABLE_CLAUDE: HarnessFocus = {
  id: "claude-code",
  name: "Claude Code",
  discovery: {
    state: "found",
    source: "configured",
    description: "SECANT_CLAUDE_CODE",
  },
  qualification: {
    state: "not-ready",
    checkedAt: "2026-09-22T00:01:00.000Z",
  },
  capabilities: QUALIFIED_CODEX.capabilities.map((capability) => ({
    capability: capability.capability,
    name: capability.name,
    description: capability.description,
    state: "not-checked",
  })),
  authenticationInstructions:
    "Log in separately through Claude Code, then inspect it again.",
  unavailable: {
    code: "harness-qualification-unavailable",
    explanation: "Claude Code requires authentication.",
    remediation: "Log in separately through Claude Code.",
    possibleEffects: "none",
  },
};

function workspace(): WorkspaceView {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    family: "workspace",
    path: "/tmp/secant-demo-workspace",
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 2,
    harnesses: [],
    actionOffers: [],
  });
  return { snapshot, approve() {} };
}

function emptyBundles(): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: [] },
  });
  return {
    openList: () => list,
    openFocus: () => {
      throw new Error("bundle catalog not used in this test");
    },
  };
}

function noLaunch(): RunLaunchView {
  return { launch: () => () => ({ kind: "pending" }) };
}

function noRun(): RunWorkbenchView {
  const unused = () => {
    throw new Error("run workbench not used in this test");
  };
  return {
    openRun: unused,
    readResource: unused,
    readTranscript: unused,
    answer: unused,
    sendInteractiveTurn: unused,
    endInteractiveStep: unused,
    steer: unused,
    answerText: unused,
    answerRequest: unused,
  };
}

function harnesses() {
  const notChecked = (harness: HarnessFocus): HarnessSummary => ({
    id: harness.id,
    name: harness.name,
    discovery: harness.discovery,
    qualification: { state: "not-checked" },
  });
  const held = new Set<HarnessFocus["id"]>();
  const [list, setList] = createSignal<HarnessCatalogSnapshot>({
    family: "harness-catalog",
    view: "list",
    harnesses: [notChecked(QUALIFIED_CODEX), notChecked(UNAVAILABLE_CLAUDE)],
  });
  const focused: HarnessFocusSelector[] = [];
  const closed: HarnessFocusSelector[] = [];
  const publishList = () => {
    setList({
      family: "harness-catalog",
      view: "list",
      harnesses: [
        held.has("codex") ? QUALIFIED_CODEX : notChecked(QUALIFIED_CODEX),
        held.has("claude-code")
          ? UNAVAILABLE_CLAUDE
          : notChecked(UNAVAILABLE_CLAUDE),
      ],
    });
  };
  return {
    view: {
      openList: () => list,
      openFocus(selector: HarnessFocusSelector) {
        focused.push(selector);
        onCleanup(() => closed.push(selector));
        const harness =
          selector.id === "codex"
            ? QUALIFIED_CODEX
            : selector.id === "claude-code"
              ? UNAVAILABLE_CLAUDE
              : undefined;
        if (harness === undefined) {
          throw new Error(`unexpected Harness focus '${selector.id}'`);
        }
        const newlyHeld = !held.has(harness.id);
        held.add(harness.id);
        if (newlyHeld) publishList();
        const [focus] = createSignal<HarnessFocusSnapshot>({
          family: "harness-catalog",
          view: "focus",
          selection: selector,
          result: { found: true, harness },
        });
        return focus;
      },
    },
    focused,
    closed,
  };
}

type TMountOptions = {
  width?: number;
  height?: number;
  catalog?: ReturnType<typeof harnesses>;
};

async function mount(options: TMountOptions = {}) {
  const width = options.width ?? 100;
  const height = options.height ?? 36;
  const catalog = options.catalog ?? harnesses();
  const exits: number[] = [];
  const t = await testRender(
    () => (
      <App
        view={workspace()}
        bundles={emptyBundles()}
        harnesses={catalog.view}
        preparation={inertLaunchPreparationView()}
        launch={noLaunch()}
        run={noRun()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        exit={() => exits.push(1)}
      />
    ),
    { width, height },
  );
  await t.waitForFrame((frame) => frame.includes("Harnesses"));
  assert.deepEqual(catalog.focused, []);
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter();
  return { t, focused: catalog.focused, closed: catalog.closed, exits };
}

test("harness-catalog-screen renders normalized rows and every inspector section", async () => {
  const { t, focused } = await mount();
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  const frame = t.captureCharFrame();

  assert.deepEqual(focused, [{ id: "codex" }]);
  assert.match(frame, /2 discovered · 1 qualified on this system/);
  assert.match(frame, /Find a Harness/);
  assert.match(frame, /Codex.*Qualified with limits/s);
  assert.match(frame, /found via PATH name 'codex'/i);
  assert.match(frame, /2 models observed/);
  assert.match(frame, /Harness · codex/);
  assert.match(frame, /Executable · PATH name 'codex' -> \/tools\/codex/);
  assert.match(frame, /Version · 1\.2\.3/);
  assert.match(frame, /Platform · linux/);
  assert.match(frame, /Checked · 2026-09-22T00:00:00\.000Z/);
  assert.match(frame, /Authentication · Ready/);
  assert.match(frame, /Supported models/);
  assert.match(frame, /gpt-5-mini · Available for Run selection/);
  assert.match(frame, /Capabilities/);
  assert.match(frame, /Session recovery · Available with limits/);
  assert.match(frame, /Limits · Reloads retained history/);
  assert.match(frame, /Structured questions · Not checked/);
  assert.doesNotMatch(
    frame,
    /Adapter|native payload|credential|Action Offers/i,
  );

  t.mockInput.pressArrow("right");
  for (let index = 0; index < 30; index += 1) {
    t.mockInput.pressArrow("down");
  }
  await t.waitForFrame((next) => next.includes("Configuration"));
  assert.match(
    t.captureCharFrame(),
    /Harness-owned settings stay with the Harness/,
  );
});

test("an unavailable Harness renders its external remediation and no action", async () => {
  const { t, focused, closed } = await mount();
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) => frame.includes("requires authentication"));
  const frame = t.captureCharFrame();

  assert.deepEqual(focused, [{ id: "codex" }, { id: "claude-code" }]);
  assert.match(frame, /Claude Code.*Not ready/s);
  assert.match(frame, /Unavailable · Claude Code requires authentication/);
  assert.match(frame, /Remediation · Log in separately through Claude Code/);
  assert.match(frame, /Authentication · Log in separately through Claude Code/);
  assert.match(frame, /Models not available yet/);
  assert.doesNotMatch(
    frame,
    /Press Enter to|retry qualification|authenticate now/i,
  );

  t.mockInput.pressArrow("up");
  await t.waitForFrame((next) =>
    next.includes("Codex · Qualified with limits"),
  );
  t.mockInput.pressArrow("down");
  await t.waitForFrame((next) => next.includes("requires authentication"));
  assert.deepEqual(focused, [{ id: "codex" }, { id: "claude-code" }]);
  assert.deepEqual(closed, []);
});

test("Harness search uses held names, models, and capabilities and explains no matches", async () => {
  const { t } = await mount();
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) => frame.includes("requires authentication"));

  await t.mockInput.typeText("gpt-5-mini");
  await t.waitForFrame((frame) => !frame.includes("Claude Code · Not ready"));
  assert.match(t.captureCharFrame(), /Codex/);

  for (let index = 0; index < "gpt-5-mini".length; index += 1) {
    t.mockInput.pressBackspace();
  }
  await t.mockInput.typeText("effective model");
  await t.waitForFrame((frame) => !frame.includes("Claude Code · Not ready"));
  assert.match(t.captureCharFrame(), /Codex/);

  for (let index = 0; index < "effective model".length; index += 1) {
    t.mockInput.pressBackspace();
  }
  await t.mockInput.typeText("missing");
  await t.waitForFrame((frame) => frame.includes("No matching Harnesses"));
  assert.match(
    t.captureCharFrame(),
    /Try a different name.*capability, model, or.*qualification state/s,
  );
});

test("Harness keymap exposes focus without colour, restores Home, and leaves printable keys to search", async () => {
  const { t, closed, exits } = await mount();
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  assert.match(t.captureCharFrame(), /│ › Codex/);
  assert.match(t.captureCharFrame(), /› Find a Harness/);

  t.mockInput.pressTab();
  await t.waitForFrame((frame) => frame.includes("› Inspector"));
  t.mockInput.pressArrow("left");
  await t.waitForFrame((frame) => frame.includes("› Find a Harness"));
  t.mockInput.pressKey("q");
  await t.waitForFrame((frame) => frame.includes("│ q"));
  assert.equal(exits.length, 0);

  t.mockInput.pressEscape();
  await until(() => /^ Secant\s*$/m.test(t.captureCharFrame()));
  assert.deepEqual(closed, [{ id: "codex" }]);
  assert.match(t.captureCharFrame(), /› Harnesses/);
  assert.match(t.captureCharFrame(), /Codex qualified/);
});

test("reopening Harnesses preserves held model search for a non-selected row", async () => {
  const { t, closed } = await mount();
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) => frame.includes("requires authentication"));
  t.mockInput.pressEscape();
  await until(() => /^ Secant\s*$/m.test(t.captureCharFrame()));
  assert.deepEqual(closed, [{ id: "codex" }, { id: "claude-code" }]);

  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  await t.waitForFrame((frame) => frame.includes("2 models observed"));
  await t.mockInput.typeText("gpt-5-mini");
  await t.waitForFrame((frame) => frame.includes("gpt-5-mini"));
  assert.match(t.captureCharFrame(), /Codex · Qualified with/);
  assert.doesNotMatch(t.captureCharFrame(), /Claude Code · Not ready/);
});

test("a fully qualified Harness counts and renders without a limits suffix", async () => {
  const limitedQualification = QUALIFIED_CODEX.qualification;
  if (
    limitedQualification.state !== "qualified" &&
    limitedQualification.state !== "qualified-with-limits"
  ) {
    throw new Error("qualified fixture lost its observation");
  }
  const qualified: HarnessFocus = {
    id: QUALIFIED_CODEX.id,
    name: QUALIFIED_CODEX.name,
    discovery: QUALIFIED_CODEX.discovery,
    qualification: {
      state: "qualified",
      observation: limitedQualification.observation,
    },
    supportedModels: QUALIFIED_CODEX.supportedModels,
    capabilities: QUALIFIED_CODEX.capabilities,
    configurationPosture: QUALIFIED_CODEX.configurationPosture,
  };
  const [list] = createSignal<HarnessCatalogSnapshot>({
    family: "harness-catalog",
    view: "list",
    harnesses: [qualified],
  });
  const focused: HarnessFocusSelector[] = [];
  const closed: HarnessFocusSelector[] = [];
  const catalog = {
    view: {
      openList: () => list,
      openFocus(selector: HarnessFocusSelector) {
        focused.push(selector);
        onCleanup(() => closed.push(selector));
        const [focus] = createSignal<HarnessFocusSnapshot>({
          family: "harness-catalog",
          view: "focus",
          selection: selector,
          result: { found: true, harness: qualified },
        });
        return focus;
      },
    },
    focused,
    closed,
  };

  const { t } = await mount({ catalog });
  await t.waitForFrame((frame) => frame.includes("1 qualified on this system"));
  assert.match(t.captureCharFrame(), /Codex · Qualified\s/);
  assert.doesNotMatch(t.captureCharFrame(), /Qualified with limits/);
});

test("unchecked discovery variants, free-text models, and a focus Problem remain inspectable", async () => {
  const unsupported: HarnessFocus = {
    id: "codex",
    name: "Codex",
    discovery: {
      state: "unsupported-shim",
      name: "codex.cmd",
      path: "/tools/codex.cmd",
      executableEnvironmentVariable: "SECANT_CODEX",
    },
    qualification: { state: "not-checked" },
    supportedModels: { kind: "free-text" },
    capabilities: QUALIFIED_CODEX.capabilities.map((capability) => ({
      capability: capability.capability,
      name: capability.name,
      description: capability.description,
      state: "not-checked",
    })),
  };
  const missing: HarnessSummary = {
    id: "claude-code",
    name: "Claude Code",
    discovery: {
      state: "not-found",
      searched: ["PATH name 'claude'"],
      executableEnvironmentVariable: "SECANT_CLAUDE_CODE",
    },
    qualification: { state: "not-checked" },
  };
  const [list] = createSignal<HarnessCatalogSnapshot>({
    family: "harness-catalog",
    view: "list",
    harnesses: [unsupported, missing],
  });
  const focused: HarnessFocusSelector[] = [];
  const closed: HarnessFocusSelector[] = [];
  const catalog = {
    view: {
      openList: () => list,
      openFocus(selector: HarnessFocusSelector) {
        const [focus] = createSignal<HarnessFocusSnapshot>({
          family: "harness-catalog",
          view: "focus",
          selection: selector,
          result:
            selector.id === "codex"
              ? { found: true, harness: unsupported }
              : {
                  found: false,
                  problem: {
                    code: "harness-not-found",
                    explanation: "The selected Harness is unavailable.",
                    remediation: "Inspect another Harness.",
                    possibleEffects: "none",
                  },
                },
        });
        return focus;
      },
    },
    focused,
    closed,
  };

  const { t } = await mount({ catalog });
  await t.waitForFrame((frame) => frame.includes("0 qualified on this system"));
  const unchecked = t.captureCharFrame();
  assert.match(unchecked, /unsupported shim \/tools\/codex\.cmd/);
  assert.match(unchecked, /Checked · Not checked/);
  assert.match(unchecked, /Authentication · Not checked/);
  assert.match(unchecked, /Free-text model entry/);

  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) =>
    frame.includes("selected Harness is unavailable"),
  );
  assert.match(
    t.captureCharFrame(),
    /not found; searched PATH.*name 'claude'/s,
  );
});

test("Harness catalog stacks and resizes without horizontal overflow", async () => {
  const { t } = await mount({ width: 50, height: 24 });
  await t.waitForFrame((frame) => frame.includes("2 discovered"));
  const assertWidth = (width: number) => {
    for (const line of t.captureCharFrame().split("\n")) {
      assert.ok(
        line.length <= width,
        `line overflows ${width} cols: ${JSON.stringify(line)}`,
      );
    }
  };
  const narrow = t.captureCharFrame().split("\n");
  const results = narrow.findIndex((line) => line.includes("Find a Harness"));
  const inspector = narrow.findIndex((line) => line.includes("Inspector"));
  assert.ok(results >= 0 && inspector > results);
  assertWidth(50);

  t.resize(38, 20);
  await t.renderOnce();
  assertWidth(38);
});
