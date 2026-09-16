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
  type HarnessAdapter,
  type PrepareResult,
} from "../../src/harness/harness.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import { installReplayer } from "../harness/replayer.js";
import {
  ensureRuntimeOnPath,
  writeCommandBundle,
} from "../helpers/commandBundle.js";
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

const TEST_REPAIR_SESSION_ID = "77777777-7777-4777-8777-777777777777";
const REPLAYER_VERSION = "2.1.273 (Claude Code)";

ensureRuntimeOnPath();

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

/** Author a single-Agent-step Bundle over the recorded Test Repair Turn. */
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

/** Wire against the Test Repair replayer with a spy Adapter, install the Agent
 *  Bundle, seed a git Workspace whose `sum.mjs` matches the recording's pre-image,
 *  and approve the Workspace. */
function wireAgent(t: TestContext): {
  wired: Wiring;
  bundleId: string;
  digest: string;
  spy: ReturnType<typeof spyAdapter>;
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

  const workspace = makeTempDir("secant-reqp-ws-");
  writeFileSync(
    join(workspace, "sum.mjs"),
    "export const sum = (a, b) => a - b;\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: workspace });

  const spy = spyAdapter(
    createClaudeCodeAdapter({ sessionId: () => TEST_REPAIR_SESSION_ID }),
  );
  const wired = wireApplication({
    secantHome: makeTempDir("secant-reqp-home-"),
    launchCwd: workspace,
    harnessAdapter: spy.adapter,
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

/** Wire a Command-only Bundle with a spy Adapter (no Harness executable needed:
 *  Preflight never discovers a Harness for a Command-only routing). */
function wireCommand(t: TestContext): {
  wired: Wiring;
  bundleId: string;
  digest: string;
  spy: ReturnType<typeof spyAdapter>;
} {
  const workspace = makeTempDir("secant-reqp-cmd-ws-");
  const spy = spyAdapter(createClaudeCodeAdapter());
  const wired = wireApplication({
    secantHome: makeTempDir("secant-reqp-cmd-home-"),
    launchCwd: workspace,
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
    "--harness-requests",
    "bogus",
  ]);
  assert.notEqual(launched.code, 0);
  assert.match(launched.err, /invalid-harness-requests/);
});
