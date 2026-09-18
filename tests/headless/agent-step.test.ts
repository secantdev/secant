import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  createClaudeCodeAdapter,
  type HarnessAdapter,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import type { RunView } from "../../src/application/projection-port.js";
import { installReplayer } from "../harness/replayer.js";
import { createFake } from "../harness/fake-adapter.js";
import { ensureRuntimeOnPath, RUNTIME_NAME } from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The first Agent Step executed headlessly (#116): a synthesized Bundle
// `command -> agent (session "s", prompt with a {{artifact:…}} file slot and a
// skill in `uses`) -> command`, launched through the composition wiring against
// the recorded plain-Turn replayer on a temporary configured command. Drives the
// Projection Port to rest `succeeded` and asserts the durable Turn view — the
// timeline kinds, the Session availability, the effective model, and the rendered
// transcript input — the headless `run show` renders.

ensureRuntimeOnPath();

// The session id, effective model, and assistant content baked into the recorded
// plain-Turn fixture; the injected Adapter mints this id so the init frame is
// acknowledged and the recording replays.
const PLAIN_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const REPLAYER_VERSION = "2.1.273 (Claude Code)";

function codexProfile(): HarnessProfile {
  return {
    harness: "Codex",
    executable: "/usr/bin/codex",
    executableVersion: "1.2.3",
    platform: "linux",
    adapterRevision: "fake-codex-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "active-turn", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    clarifications: { available: false, evidence: "scripted fake" },
    steer: { available: true, evidence: "scripted fake" },
    modelSelection: { at: "unavailable", evidence: "scripted fake" },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "scripted fake",
    },
    skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
    fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
  };
}

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

/** Author a `command -> agent -> command` Bundle folder: a `file` Launch input
 *  fills the prompt's `{{artifact:doc}}` slot, and a `skill` asset in the agent's
 *  `uses` appends a SKILL.md line. Command-only bookends run the runtime binary. */
function writeAgentBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-agent-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  mkdirSync(join(folder, "guide"), { recursive: true });
  writeFileSync(
    join(folder, "prompts", "fix.md"),
    "Repair the failing test in {{artifact:doc}}.\n",
  );
  writeFileSync(
    join(folder, "guide", "SKILL.md"),
    "# Repair guide\nFollow the repair playbook.\n",
  );
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.agent-e2e",
      version: "1.0.0",
      name: "Agent E2E",
      description:
        "A command -> agent -> command Bundle for the first Agent Step.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: { doc: { type: "file", description: "the file to repair" } },
    assets: [
      { path: "prompts/fix.md", kind: "prompt" },
      { path: "guide", kind: "skill" },
    ],
    routing: [
      {
        id: "before",
        kind: "command",
        command: {
          executable: RUNTIME_NAME,
          arguments: ["-e", "process.exit(0)"],
        },
      },
      {
        id: "fix",
        kind: "agent",
        session: "s",
        requires: ["doc"],
        prompt: { asset: "prompts/fix.md" },
        uses: [{ asset: "guide" }],
      },
      {
        id: "after",
        kind: "command",
        command: {
          executable: RUNTIME_NAME,
          arguments: ["-e", "process.exit(0)"],
        },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

/** Wire the Application against a temporary home and the plain-Turn replayer as the
 *  configured Claude Code, install the Agent Bundle, and approve the Workspace. */
function wireAgent(t: TestContext): {
  wired: Wiring;
  bundleId: string;
  digest: string;
  docPath: string;
} {
  const replayer = installReplayer(REPLAYER_VERSION, fixtureCase("plain"));
  // `executablePath` is already the replayer's absolute path; the configured
  // command resolves straight to it, so discovery never falls through to a real
  // `claude` on PATH (no real Harness runs in CI, ADR 0027).
  const executable = replayer.executablePath;
  const savedEnv = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  process.env[CLAUDE_CODE_EXECUTABLE_ENV] = executable;
  t.after(() => {
    if (savedEnv === undefined) delete process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    else process.env[CLAUDE_CODE_EXECUTABLE_ENV] = savedEnv;
  });

  const workspace = makeTempDir("secant-agent-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-agent-home-"),
    launchCwd: workspace,
    // The Adapter mints the fixture's session id so the recorded init acknowledges.
    harnessAdapter: createClaudeCodeAdapter({
      sessionId: () => PLAIN_SESSION_ID,
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

  const docPath = join(makeTempDir("secant-agent-doc-"), "failing.test.ts");
  writeFileSync(docPath, "test('x', () => { throw new Error('fail'); });\n");

  return { wired, bundleId: bundle.id, digest: entry.digest, docPath };
}

async function launchAgentRun(t: TestContext): Promise<{
  wired: Wiring;
  runId: string;
  run: RunView;
  docPath: string;
}> {
  const { wired, bundleId, digest, docPath } = wireAgent(t);
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundleId },
      launchInputs: { doc: docPath },
      trustDigest: digest,
      harness: "claude-code",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");

  const opened = wired.projectionPort.openProjection({ family: "run", runId });
  try {
    assert.ok(opened.snapshot.result.found, JSON.stringify(opened.snapshot));
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    return { wired, runId, run: opened.snapshot.result.run, docPath };
  } finally {
    opened.close();
  }
}

test("[both-client-harness-selection] headless launch requires and accepts the shared semantic Harness choice", async (t) => {
  const { wired, bundleId, digest, docPath } = wireAgent(t);
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: () => process.cwd(),
  };
  const base = [
    "run",
    "launch",
    bundleId,
    "--trust",
    digest,
    "--input",
    `doc=${docPath}`,
  ];

  assert.equal(await runHeadless(wired, base, io), 1);
  assert.match(err.join(""), /harness-selection-required/);
  err.length = 0;

  assert.equal(
    await runHeadless(wired, base.concat("--harness", "gemini"), io),
    1,
  );
  assert.match(err.join(""), /harness-selection-unknown/);
  err.length = 0;

  const selectedCode = await runHeadless(
    wired,
    base.concat("--harness", "claude-code"),
    io,
  );
  assert.equal(selectedCode, 0, `${out.join("")}\n${err.join("")}`);
  const runId = /^Run (\S+)$/m.exec(out.join(""))?.[1];
  assert.ok(runId);
  const record = wired.runGroup.readRun(runId);
  assert.ok(record.ok);
  assert.equal(record.run.selectedHarness, "claude-code");
});

test("headless Codex preparation failure keeps JSON stable and resume reuses the durable selection", async (t) => {
  const workspace = makeTempDir("secant-headless-codex-ws-");
  const successful = createFake({
    profile: codexProfile(),
    turns: [
      {
        result: {
          kind: "completed",
          detail: {
            finalContent: "done",
            effectiveModel: { known: true, model: "gpt-6" },
            session: { state: "open" },
          },
        },
      },
    ],
  })();
  let prepareCount = 0;
  const adapter: HarnessAdapter = {
    async prepare(options) {
      prepareCount++;
      if (prepareCount === 1) {
        return {
          ok: false,
          failure: {
            phase: "prepare",
            category: "authentication",
            possibleEffects: "none",
            nativeCode: "login-required",
            retryEvidence: "safe after separate login",
            diagnostics: "Codex is not authenticated.",
          },
        };
      }
      return successful.prepare(options);
    },
  };
  const wired = wireApplication({
    secantHome: makeTempDir("secant-headless-codex-home-"),
    launchCwd: workspace,
    codexHarnessAdapter: adapter,
    discoverCodex: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "codex",
        description: "PATH name 'codex'",
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
  const entry = wired.catalog.listEntries().find((candidate) => {
    return candidate.id === bundle.id;
  });
  assert.ok(entry);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "approve-headless-codex",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const docPath = join(makeTempDir("secant-codex-doc-"), "failing.test.ts");
  writeFileSync(docPath, "test('x', () => {});\n");
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: () => workspace,
  };

  const launchCode = await runHeadless(
    wired,
    [
      "run",
      "launch",
      bundle.id,
      "--trust",
      entry.digest,
      "--input",
      `doc=${docPath}`,
      "--harness",
      "codex",
      "--json",
    ],
    io,
  );
  assert.equal(launchCode, 1, err.join(""));
  const problem = JSON.parse(out.join(""));
  assert.equal(problem.code, "selected-harness-unavailable");
  assert.equal(problem.details.harness, "codex");
  assert.equal(problem.details.nativeCode, "login-required");
  const runId = problem.details.runId;
  assert.equal(typeof runId, "string");
  out.length = 0;

  const resumeCode = await runHeadless(
    wired,
    ["run", "resume", runId, "--json"],
    io,
  );
  assert.equal(resumeCode, 0, err.join(""));
  const snapshot = JSON.parse(out.join(""));
  assert.equal(snapshot.family, "run");
  assert.equal(snapshot.runId, runId);
  assert.equal(snapshot.result.found, true);
  assert.equal(snapshot.result.run.state, "succeeded");
  assert.ok(Array.isArray(snapshot.result.run.progress));
  assert.ok(Array.isArray(snapshot.result.run.timeline));
  assert.ok(Array.isArray(snapshot.result.run.outputs));
  assert.ok(Array.isArray(snapshot.result.run.actionOffers));
  assert.equal(snapshot.result.run.harness.name, "Codex");
  const record = wired.runGroup.readRun(runId);
  assert.ok(record.ok);
  assert.equal(record.run.selectedHarness, "codex");
  assert.equal(prepareCount, 2);
});

/** Run one headless command against the wired clients and capture its stdout. */
async function runShow(wired: Wiring, runId: string): Promise<string> {
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
    ["run", "show", runId],
    io,
  );
  assert.equal(code, 0);
  return out.join("");
}

test("a command -> agent -> command Bundle runs the plain Turn to succeeded (#116)", async (t) => {
  const { run } = await launchAgentRun(t);

  assert.equal(run.state, "succeeded");
  // The durable Turn view: one Session `s` open, the effective model from init, one
  // Turn admitted.
  assert.equal(run.sessions?.length, 1);
  const session = run.sessions?.[0];
  assert.equal(session?.session, "s");
  assert.equal(session?.availability, "open");
  // #124: a Session with a transcript advertises its typed page/export References.
  assert.deepEqual(session?.transcriptPage, {
    runId: run.runId,
    session: "s",
    type: "transcript-page",
  });
  assert.deepEqual(session?.transcriptExport, {
    runId: run.runId,
    session: "s",
    type: "transcript-export",
  });
  assert.match(run.effectiveModel ?? "", /^claude-/);
  assert.equal(run.turnPosition, 1);
  assert.equal("transcript" in run, false);

  // The normalized Harness identity of the latest Agent-step Attempt (#125): the
  // observed name, the resolved executable, and the observed version — never inferred
  // from configuration.
  assert.equal(run.harness?.name, "claude-code");
  assert.ok(
    (run.harness?.executable ?? "").length > 0,
    run.harness?.executable,
  );
  assert.match(run.harness?.executableVersion ?? "", /2\.1\.273/);

  // The timeline carries the Agent-Turn kinds the acceptance criterion names.
  const kinds = run.timeline.map((event) => event.event);
  assert.ok(kinds.includes("turn-started"), JSON.stringify(kinds));
  assert.ok(kinds.includes("assistant-content"), JSON.stringify(kinds));
  assert.ok(kinds.includes("turn-settled"), JSON.stringify(kinds));
  const settled = run.timeline.find((event) => event.event === "turn-settled");
  assert.equal(settled?.detail, "completed");
  // The durable Turn events carry the recorded Crucible Turn kind (#126) additively,
  // so a client labels reopened history without inferring from the Run's position.
  const started = run.timeline.find((event) => event.event === "turn-started");
  assert.equal(started?.turnKind, "agent");
  assert.equal(settled?.turnKind, "agent");
});

test("run show prints the Turn timeline, Session availability, and effective model (#116)", async (t) => {
  const { wired, runId } = await launchAgentRun(t);
  const shown = await runShow(wired, runId);
  assert.match(shown, /turn-started agent/); // the recorded Turn kind (#126)
  assert.match(shown, /assistant-content/);
  assert.match(shown, /turn-settled agent/);
  assert.match(shown, /Sessions:/);
  assert.match(shown, /s: open/);
  assert.match(shown, /Effective model: claude-/);
  // The Harness identity the same `run` Projection carries (#125): name, executable,
  // and version rendered alongside the effective model.
  assert.match(shown, /Harness: claude-code/);
  assert.match(shown, /Executable: .+/);
  assert.match(shown, /Version: 2\.1\.273/);
  assert.doesNotMatch(shown, /Transcript:/);
});

test("run show --json gains additive Harness-identity fields (#125)", async (t) => {
  const { wired, runId } = await launchAgentRun(t);
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
    ["run", "show", runId, "--json"],
    io,
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(out.join(""));
  const run = parsed.result.run;
  // Additive to the frozen `--json`: the existing `effectiveModel` stays, and a new
  // normalized `harness` object carries the identity — no native id crosses.
  assert.equal(run.harness.name, "claude-code");
  assert.match(run.harness.executableVersion, /2\.1\.273/);
  assert.ok(typeof run.harness.executable === "string");
  assert.match(run.effectiveModel, /^claude-/);
});

test("the rendered prompt carries the file's absolute path and the skill's SKILL.md, no @ (#116)", async (t) => {
  const { wired, run, docPath } = await launchAgentRun(t);
  const reference = run.sessions?.[0]?.transcriptPage;
  assert.ok(reference);
  const transcript = wired.projectionPort.readTranscript(reference);
  assert.ok(transcript.found);
  if (!transcript.found) throw new Error("unreachable");
  const input = transcript.entries.find(
    (entry) => entry.role === "user",
  )?.content;
  assert.ok(input !== undefined, JSON.stringify(transcript.entries));
  // The `file` slot renders as the file's absolute path; the `skill` in `uses`
  // appends a line naming its SKILL.md at an absolute path; no Harness `@` syntax.
  assert.ok(input.includes(docPath), input);
  assert.match(input, /SKILL\.md/);
  assert.ok(!input.includes("@"), input);
});
