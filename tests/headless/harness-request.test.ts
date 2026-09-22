import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type { HarnessProfile, TurnResult } from "../../src/harness/harness.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import type {
  ProjectionUpdate,
  RunLiveOverlay,
  RunSnapshot,
} from "../../src/application/projection-port.js";

/** Await the first live overlay matching `predicate` (an outstanding request). */
async function nextOverlay(
  updates: AsyncIterable<ProjectionUpdate<RunSnapshot>>,
  predicate: (overlay: RunLiveOverlay) => boolean,
): Promise<RunLiveOverlay> {
  for await (const update of updates) {
    if (update.kind === "live" && predicate(update.overlay))
      return update.overlay;
  }
  throw new Error("the update stream closed before a matching overlay arrived");
}

// #117 AC1 end-to-end: a single-Agent-step Bundle whose Turn raises an Edit
// approval request, launched headlessly with `--harness-requests allow`, pauses on
// the Edit approval, answers it through `answer-harness-request`, and runs to
// `succeeded`; `run show` prints `request-raised` with the exact tool and input and
// `request-answered` "answered by client policy". With `deny` the request is denied
// and the Run's outcome still follows the script (the Turn completes). Driven
// against the deterministic fake Claude Code Harness and an injected fake Process,
// so no child spawns (#185).

/** The fake Claude Code profile: it hosts a permission bridge, so an Agent Turn can
 *  raise an approval Harness Request. */
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
    steer: {
      available: false,
      evidence: "fake claude has no same-Turn guidance frame",
    },
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

const COMPLETED_OPEN: TurnResult = {
  kind: "completed",
  detail: {
    finalContent: "repaired the workspace",
    effectiveModel: { known: false },
    session: { state: "open" },
  },
};

/** The single-Turn script every case drives: one awaited Edit approval request
 *  naming `sum.mjs` holds the Turn open until it is answered (by client policy for
 *  `run launch`, or by hand for the paused-overlay case), then the Turn completes. */
function requestScript(): FakeScript {
  return {
    profile: claudeProfile(),
    turns: [
      {
        requests: [
          {
            id: "req-edit",
            shape: {
              kind: "approval",
              tool: "Edit",
              input: "edit sum.mjs",
              decisions: ["allow", "deny"],
            },
            awaited: true,
          },
        ],
        result: COMPLETED_OPEN,
      },
    ],
  };
}

/** Author a single-Agent-step Bundle: one `agent` Step in session `s` with a
 *  prompt asset. The prompt text is irrelevant — the fake Harness raises its
 *  scripted request regardless of input — but a prompt asset must exist for
 *  Composition. */
function writeAgentBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-req-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(
    join(folder, "prompts", "fix.md"),
    "Repair the failing test in the workspace.\n",
  );
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.req-e2e",
      version: "1.0.0",
      name: "Harness Request E2E",
      description: "A single Agent Step Bundle for the approval-request slice.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/fix.md", kind: "prompt" }],
    routing: [
      {
        id: "fix",
        kind: "agent",
        session: "s",
        prompt: { asset: "prompts/fix.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

/** Wire the Application against the fake Claude Code Harness and an injected fake
 *  Process (no child spawns), install the Bundle, seed a Workspace, and approve it. */
function wire(t: TestContext): {
  wired: Wiring;
  bundleId: string;
  digest: string;
} {
  const workspace = makeTempDir("secant-req-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-req-home-"),
    launchCwd: workspace,
    process: createFakeBundleProcess(),
    harnessAdapter: createFake(requestScript())(),
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

/** Run one headless command against the wired clients and capture stdout + exit. */
async function headless(
  wired: Wiring,
  argv: readonly string[],
): Promise<{ code: number; out: string }> {
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
    [...argv],
    io,
  );
  return { code, out: out.join("") };
}

/** The Run id a `run launch` printed ("Run <id>"). */
function runIdOf(out: string): string {
  const match = /Run (\S+)/.exec(out);
  assert.ok(match, `no Run id in launch output:\n${out}`);
  return match[1]!;
}

test("run launch --harness-requests allow answers the Edit approval and succeeds (#117 AC1)", async (t) => {
  const { wired, bundleId, digest } = wire(t);
  const launched = await headless(wired, [
    "run",
    "launch",
    bundleId,
    "--trust",
    digest,
    "--harness",
    "claude-code",
    "--harness-requests",
    "allow",
  ]);
  assert.equal(launched.code, 0, launched.out);
  const runId = runIdOf(launched.out);

  const shown = await headless(wired, ["run", "show", runId]);
  assert.equal(shown.code, 0, shown.out);
  // The durable timeline prints the raised approval (exact tool and input) and the
  // answer, naming the client policy as the answerer.
  assert.match(shown.out, /request-raised/);
  assert.match(shown.out, /Edit/);
  assert.match(shown.out, /sum\.mjs/);
  assert.match(shown.out, /request-answered.*answered by client policy/);
});

test("run launch --harness-requests deny denies the approval and follows the recording (#117 AC1)", async (t) => {
  const { wired, bundleId, digest } = wire(t);
  // `deny` is also the default; pass it explicitly to pin the policy under test.
  const launched = await headless(wired, [
    "run",
    "launch",
    bundleId,
    "--trust",
    digest,
    "--harness",
    "claude-code",
    "--harness-requests",
    "deny",
  ]);
  // The recording completes whatever the verdict, so the Run still succeeds; the
  // difference is the recorded decision on the timeline.
  assert.equal(launched.code, 0, launched.out);
  const runId = runIdOf(launched.out);

  const shown = await headless(wired, ["run", "show", runId]);
  assert.match(
    shown.out,
    /request-answered.*answered by client policy \(deny\)/,
  );
});

test("run show names the ephemeral Harness Request from the live overlay while a Turn is paused (#117, A15) — unreachable at HEAD", async (t) => {
  const { wired, bundleId, digest } = wire(t);
  // Launch directly through the Port with no follower, so the Edit approval stays
  // outstanding and the Turn stays paused for `run show` to observe (the headless `run
  // launch` would answer it by policy at once, leaving only a durable timeline entry).
  const admission = wired.projectionPort.submit({
    operationId: "op-launch-a15",
    operation: "launch-run",
    input: {
      bundle: { id: bundleId },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
    },
  });
  assert.ok(
    admission.admitted && admission.runId !== undefined,
    JSON.stringify(admission),
  );
  const runId = admission.runId;

  // Wait until the Turn pauses on the Edit approval, then read the request to answer.
  const opened = wired.projectionPort.openProjection({
    family: "run",
    runId,
  });
  const overlay = await nextOverlay(
    opened.updates,
    (o) => o.outstanding.length > 0,
  );
  opened.close();

  // `run show` reads the live overlay and names the third blocked basis — unreachable at
  // HEAD, which read only the durable snapshot and printed `State: running` with no hint.
  const shown = await headless(wired, ["run", "show", runId]);
  assert.equal(shown.code, 0, shown.out);
  assert.match(shown.out, /Blocked: ephemeral Harness Request/);
  assert.match(shown.out, /Harness Request:/);
  assert.match(shown.out, /tool: Edit/);
  assert.match(shown.out, /sum\.mjs/); // the exact input Claude Code asked to run

  // Answer the outstanding request so the Turn completes and the Run settles, leaving no
  // paused live process for teardown to kill.
  const offer = overlay.offers[0]!;
  wired.projectionPort.submit({
    operationId: "op-answer-a15",
    operation: "answer-harness-request",
    input: {
      runId,
      requestId: offer.requestId,
      generation: offer.generation,
      decision: "allow",
      by: "human",
    },
  });
  assert.equal(
    (await awaitSettled(wired.projectionPort, "op-launch-a15")).status,
    "applied",
  );
});
