import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  type HarnessAdapter,
  type HarnessProfile,
  type PrepareResult,
  type TurnResult,
} from "../../src/harness/harness.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { writeCommandBundle } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";

// #117 AC3/AC5 and the `--harness-requests` flag: the permission bridge is started
// only for Runs whose routing needs a Harness (an Agent Step), so a Command-only
// Bundle prepares no Harness and starts no bridge, while an Agent Bundle prepares
// exactly one and closes it once the Run rests. The `--harness-requests` policy
// defaults to `deny`, so an unattended headless Agent Run answers each approval and
// still terminates; an invalid policy is refused precisely.
//
// The permission bridge is started lazily inside the Adapter, only when a Turn
// raises a prompt, and composition prepares a Harness only for a routing that needs
// one (`needsHarness`, src/composition/wiring.ts). So the count of `prepare` calls
// is the honest, portable proxy for "did a bridge come into being for this Run"
// (asserting a loopback listener directly is not portable across the three OSes).
//
// Process-free: the Agent Step runs against the deterministic fake Harness Adapter
// (an awaited approval Turn), and every Bundle is driven through an injected fake
// Process, so no real child spawns and no Harness is recorded/replayed (#185).

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

/** The single-Agent-Turn script: one awaited Edit approval holds the Turn open until
 *  the headless follower answers it per policy, then the Turn completes — the shape
 *  the policy assertions observe (answered `allow`/`deny`, then the Run rests). */
function agentScript(): FakeScript {
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
              input: "change file",
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

/** A Harness Adapter spy that counts `prepare` calls and, per prepared Harness,
 *  wraps `close` to count how many were torn down — the composition capability-need
 *  seam's observable: zero for a Command-only Run, one-prepared-one-closed for an
 *  Agent Run. */
function spyAdapter(inner: HarnessAdapter): {
  adapter: HarnessAdapter;
  prepareCount: () => number;
  closeCount: () => number;
} {
  let prepares = 0;
  let closes = 0;
  const adapter: HarnessAdapter = {
    async prepare(options): Promise<PrepareResult> {
      prepares++;
      const result = await inner.prepare(options);
      if (!result.ok) return result;
      const harness = result.harness;
      return {
        ok: true,
        harness: {
          profile: harness.profile,
          startTurn: (request) => harness.startTurn(request),
          close: () => {
            closes++;
            return harness.close();
          },
        },
      };
    },
  };
  return { adapter, prepareCount: () => prepares, closeCount: () => closes };
}

/** Author a single-Agent-step Bundle over the fake approval Turn. */
function writeAgentBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-reqp-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(
    join(folder, "prompts", "fix.md"),
    "Repair the failing test in the workspace.\n",
  );
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.reqp-agent",
      version: "1.0.0",
      name: "Harness Request Policy Agent",
      description:
        "A single Agent Step Bundle for the approval-request policy.",
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

/** Wire against the fake approval-Turn Adapter with a spy, over an injected fake
 *  Process, install the Agent Bundle in a fresh Workspace, and approve it. Harness
 *  discovery is stubbed `found`, so `--harness claude-code` passes Preflight with no
 *  executable and no spawn. */
function wireAgent(t: TestContext): {
  wired: Wiring;
  bundleId: string;
  digest: string;
  spy: ReturnType<typeof spyAdapter>;
} {
  const workspace = makeTempDir("secant-reqp-ws-");
  const spy = spyAdapter(createFake(agentScript())());
  const wired = wireApplication({
    secantHome: makeTempDir("secant-reqp-home-"),
    launchCwd: workspace,
    process: createFakeBundleProcess(),
    harnessAdapter: spy.adapter,
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
  return { wired, bundleId: bundle.id, digest: entry.digest, spy };
}

/** Wire a Command-only Bundle with a spy Adapter over an injected fake Process (no
 *  Harness needed: Preflight never discovers a Harness for a Command-only routing). */
function wireCommand(t: TestContext): {
  wired: Wiring;
  bundleId: string;
  digest: string;
  spy: ReturnType<typeof spyAdapter>;
} {
  const workspace = makeTempDir("secant-reqp-cmd-ws-");
  const spy = spyAdapter(createFake(agentScript())());
  const wired = wireApplication({
    secantHome: makeTempDir("secant-reqp-cmd-home-"),
    launchCwd: workspace,
    process: createFakeBundleProcess(),
    harnessAdapter: spy.adapter,
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const bundle = writeCommandBundle({ id: "dev.secant.reqp-command" });
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
  return { wired, bundleId: bundle.id, digest: entry.digest, spy };
}

/** Run one headless command, capturing stdout, stderr, and exit code. */
async function headless(
  wired: Wiring,
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
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
  return { code, out: out.join(""), err: err.join("") };
}

function runIdOf(out: string): string {
  const match = /Run (\S+)/.exec(out);
  assert.ok(match, `no Run id in launch output:\n${out}`);
  return match[1]!;
}

test("a Command-only Bundle prepares no Harness and starts no bridge (#117 AC3)", async (t) => {
  const { wired, bundleId, digest, spy } = wireCommand(t);
  const launched = await headless(wired, [
    "run",
    "launch",
    bundleId,
    "--trust",
    digest,
  ]);
  assert.equal(launched.code, 0, launched.out + launched.err);
  const runId = runIdOf(launched.out);
  const shown = await headless(wired, ["run", "show", runId]);
  assert.match(shown.out, /State: succeeded/);
  // No Harness was prepared, so no permission bridge came into being for this Run.
  assert.equal(spy.prepareCount(), 0);
  assert.equal(spy.closeCount(), 0);
});

test("an Agent Bundle prepares exactly one Harness and closes it once the Run rests (#117 AC3)", async (t) => {
  const { wired, bundleId, digest, spy } = wireAgent(t);
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
  assert.equal(launched.code, 0, launched.out + launched.err);
  // Exactly one Harness prepared for the Run, and it is gone (closed) once the Run
  // rests — the "exactly one bridge per Run, gone at rest" evidence.
  assert.equal(spy.prepareCount(), 1);
  assert.equal(spy.closeCount(), 1);
});

test("the default --harness-requests policy is deny and an agent Run still terminates (#117 AC5)", async (t) => {
  const { wired, bundleId, digest } = wireAgent(t);
  // No --harness-requests flag: the default policy answers each approval `deny`, so
  // the Run does not hang; the recording completes, so it rests succeeded.
  const launched = await headless(wired, [
    "run",
    "launch",
    bundleId,
    "--trust",
    digest,
    "--harness",
    "claude-code",
  ]);
  assert.equal(launched.code, 0, launched.out + launched.err);
  const runId = runIdOf(launched.out);
  const shown = await headless(wired, ["run", "show", runId]);
  assert.match(
    shown.out,
    /request-answered.*answered by client policy \(deny\)/,
  );
});

test("an invalid --harness-requests policy is refused precisely", async (t) => {
  const { wired, bundleId, digest } = wireAgent(t);
  const launched = await headless(wired, [
    "run",
    "launch",
    bundleId,
    "--trust",
    digest,
    "--harness",
    "claude-code",
    "--harness-requests",
    "bogus",
  ]);
  assert.notEqual(launched.code, 0);
  assert.match(launched.err, /invalid-harness-requests/);
});
