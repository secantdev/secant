import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSnapshot,
  LaunchRunInput,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";
import { wireApplication } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import {
  App,
  createLiveRunLaunchView,
  createLiveRunWorkbenchView,
  type BundleCatalogView,
  type RunLaunchView,
  type WorkspaceView,
} from "../../src/tui/tui.js";
import type {
  RendererKeyEvent,
  RendererPort,
} from "../../src/tui/renderer/renderer.js";
import { createFake } from "../harness/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { inertRunActionsView, inertRunListView } from "./inert.js";

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
    modelSelection: { at: "unavailable", evidence: "scripted fake" },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "scripted fake",
    },
    skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
    fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
  };
}

function writeAgentBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-tui-live-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "repair.md"), "Repair the test.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.tui-live",
      version: "1.0.0",
      name: "TUI Live Turn",
      description: "A live Turn renderer fixture.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/repair.md", kind: "prompt" }],
    routing: [
      {
        id: "repair",
        kind: "agent",
        session: "repair",
        prompt: { asset: "prompts/repair.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

function renderer(
  width: number,
  height: number,
): {
  port: RendererPort;
  key(name: string): void;
} {
  const keys = new Set<(event: RendererKeyEvent) => void>();
  return {
    port: {
      size: () => ({ width, height }),
      onKey: (listener) => {
        keys.add(listener);
        return () => keys.delete(listener);
      },
      onResize: () => () => {},
      destroy() {},
      destroyed: false,
    },
    key: (name) => {
      for (const listener of keys) listener({ name });
    },
  };
}

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

test("a scripted fake Harness streams through the Port into the Run Workbench", async (t) => {
  const savedExecutable = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  process.env[CLAUDE_CODE_EXECUTABLE_ENV] = process.execPath;
  t.after(() => {
    if (savedExecutable === undefined)
      delete process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    else process.env[CLAUDE_CODE_EXECUTABLE_ENV] = savedExecutable;
  });

  const workspace = makeTempDir("secant-tui-live-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-tui-live-home-"),
    launchCwd: workspace,
    harnessAdapter: createFake({
      profile: profile(),
      turns: [
        {
          events: [
            {
              kind: "session",
              availability: { state: "open" },
              facts: {
                recoveryCoordinate: { opaque: "fake-session" },
                executableVersion: "0.0.0-fake",
                tools: ["Edit"],
                mcp: [],
              },
            },
            {
              kind: "model",
              observation: { known: true, model: "fake-sonnet" },
            },
            { kind: "preview", text: "Streaming the repair" },
            {
              kind: "tool-activity",
              activity: {
                tool: "Edit",
                phase: "started",
                summary: "editing src/fix.ts",
              },
            },
            { kind: "activity", description: "delegating to subagent" },
            {
              kind: "context",
              observation: { usedTokens: 12_500, limitTokens: 200_000 },
            },
            {
              kind: "usage",
              observation: { estimate: true, summary: "estimated 25 tokens" },
            },
          ],
          requests: [
            {
              id: "edit-1",
              shape: {
                kind: "approval",
                tool: "Edit",
                input: '{"path":"src/fix.ts"}',
                decisions: ["allow", "deny"],
              },
              awaited: true,
            },
          ],
          result: {
            kind: "completed",
            detail: {
              finalContent: "The repair is complete.",
              effectiveModel: { known: true, model: "fake-sonnet" },
              session: { state: "open" },
            },
          },
        },
      ],
    })(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const bundle = writeAgentBundle();
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog
    .listEntries()
    .find((item) => item.id === bundle.id);
  assert.ok(entry);
  const approval = wired.projectionPort.submit({
    operationId: "approve-workspace",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approval.admitted);

  const workspaceProjection = wired.projectionPort.openProjection({
    family: "workspace",
  });
  const listProjection = wired.projectionPort.openProjection({
    family: "bundle-catalog",
  });
  const focusProjection = wired.projectionPort.openProjection({
    family: "bundle-catalog",
    focus: { id: bundle.id },
  });
  t.after(() => {
    workspaceProjection.close();
    listProjection.close();
    focusProjection.close();
  });

  const liveLaunch = createLiveRunLaunchView(wired.projectionPort);
  let launched: ReturnType<RunLaunchView["launch"]> | undefined;
  const launch: RunLaunchView = {
    launch(input: LaunchRunInput) {
      launched = liveLaunch.launch(input);
      return launched;
    },
  };
  const fakeRenderer = renderer(120, 32);
  const rendered = await testRender(
    () => (
      <App
        view={workspaceView(workspaceProjection.snapshot)}
        bundles={catalogView(listProjection.snapshot, focusProjection.snapshot)}
        launch={launch}
        run={createLiveRunWorkbenchView(wired.projectionPort)}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={fakeRenderer.port}
        exit={() => {}}
      />
    ),
    { width: 120, height: 32 },
  );
  await rendered.waitForFrame((frame) => frame.includes("Secant"));
  rendered.mockInput.pressArrow("down");
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("acknowledge"));
  rendered.mockInput.pressKey("a");
  await rendered.waitForFrame((frame) => frame.includes("Trust acknowledged"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) => frame.includes("Review"));
  rendered.mockInput.pressEnter();
  await rendered.waitForFrame((frame) =>
    frame.includes("Harness Request · Edit"),
  );

  // The approval request replaces the bottom input with the inline decision control
  // naming the exact tool and input and both offered decisions (#121 AC1).
  await rendered.waitForFrame((frame) =>
    frame.includes("Harness Request · awaiting your approval"),
  );
  const frame = rendered.captureCharFrame();
  assert.match(frame, /BLOCKED · ephemeral Harness Request/);
  assert.match(frame, /Assistant preview · Streaming the repair/);
  assert.match(frame, /Activity · delegating to subagent/);
  assert.match(frame, /Context · 12500 \/ 200000 tokens/);
  assert.match(frame, /Usage · estimated 25 tokens/);
  assert.match(frame, /Tool: Edit/); // the exact tool
  assert.match(frame, /\[ Allow \]/); // both offered decisions
  assert.match(frame, /\[ Deny \]/);

  const receipt = launched?.();
  assert.equal(receipt?.kind, "launched");
  if (receipt?.kind !== "launched") throw new Error("Run was not launched");
  // Answer allow *through the control*, over the real Port: Enter on the default
  // (allow) decision dispatches `answer-harness-request` and the Turn continues to
  // completion — the whole client wiring, not a hand-built Port submit (#121 AC1).
  fakeRenderer.key("return");
  await rendered.waitForFrame(
    (next) => next.includes("SUCCEEDED") && next.includes("model fake-sonnet"),
  );
  const settled = rendered.captureCharFrame();
  assert.match(settled, /Claude Code · model fake-sonnet/);
  assert.match(settled, /Tool activity · Edit started/);
  assert.doesNotMatch(settled, /Assistant preview/);
});
