import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  createClaudeCodeAdapter,
} from "../../src/harness/harness.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import { installReplayer } from "../harness/replayer.js";
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

// #117 AC1 end-to-end: a synthesized Agent Bundle over the recorded Test Repair
// fix-Turn, launched headlessly with `--harness-requests allow`, pauses on the Edit
// approval, answers it through `answer-harness-request`, and runs to `succeeded`;
// `run show` prints `request-raised` with the exact tool and input and
// `request-answered` "answered by client policy". With `deny` the request is denied
// and the Run's outcome still follows the recording (the fixture completes).

// The session id baked into the Test Repair recording; the injected Adapter mints
// it so the recorded init frame is acknowledged and the recording replays.
const TEST_REPAIR_SESSION_ID = "77777777-7777-4777-8777-777777777777";
const REPLAYER_VERSION = "2.1.273 (Claude Code)";

function fixtureCase(name: string): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "harness",
    "fixtures",
    "claude-code",
    name,
  );
}

/** Author a single-Agent-step Bundle: one `agent` Step in session `s` with a
 *  prompt asset. The prompt text is irrelevant — the replayer replays the recorded
 *  Turn regardless of input — but a prompt asset must exist for Composition. */
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

/** Wire the Application against the Test Repair replayer, install the Bundle, seed
 *  a git Workspace whose `sum.mjs` matches the recording's pre-image (so the Turn's
 *  recorded workspace patch applies), and approve the Workspace. */
function wire(t: TestContext): {
  wired: Wiring;
  bundleId: string;
  digest: string;
} {
  const replayer = installReplayer(
    REPLAYER_VERSION,
    fixtureCase("test-repair"),
  );
  const savedEnv = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  process.env[CLAUDE_CODE_EXECUTABLE_ENV] = replayer.executablePath;
  t.after(() => {
    if (savedEnv === undefined) delete process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    else process.env[CLAUDE_CODE_EXECUTABLE_ENV] = savedEnv;
  });

  const workspace = makeTempDir("secant-req-ws-");
  // The recording's workspace patch edits `sum.mjs`; seed it (and a git work tree
  // so `git apply` in the replayer succeeds) with the exact pre-image bytes.
  writeFileSync(
    join(workspace, "sum.mjs"),
    "export const sum = (a, b) => a - b;\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: workspace });

  const wired = wireApplication({
    secantHome: makeTempDir("secant-req-home-"),
    launchCwd: workspace,
    harnessAdapter: createClaudeCodeAdapter({
      sessionId: () => TEST_REPAIR_SESSION_ID,
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
    input: { bundle: { id: bundleId }, launchInputs: {}, trustDigest: digest },
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
