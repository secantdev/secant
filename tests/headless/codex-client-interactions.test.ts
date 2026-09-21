import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  APPROVAL_DECISIONS,
  type HarnessProfile,
  type TurnEvent,
  type TurnResult,
} from "../../src/harness/harness.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The headless client drives a selected Codex Run through the same contract as Claude
// Code (#148, spec stories 28–34): the `--harness-requests` policy answers Codex
// approvals, the exit code follows the rest state, and the frozen `--json` fields are
// unchanged with only additive Harness-selection evidence. Driven against the
// deterministic fake Codex Harness and an injected fake Process — no child spawns
// (#185, ADR 0027).

const APPROVAL_PROMPT =
  "Run `touch /tmp/secant-codex-recording-approval` now. Do not do anything else.";

// The fake Codex Harness's profile: Codex hosts approvals and offers native steer,
// the one client-visible difference from Claude Code.
function codexProfile(): HarnessProfile {
  return {
    harness: "codex",
    executable: "codex",
    executableVersion: "0.0.0-fake-codex",
    platform: "linux",
    adapterRevision: "fake-codex-1",
    configurationPosture: "user-compatible",
    recovery: {
      mode: "native-reattach",
      evidence: "fake codex reattaches a thread",
    },
    interruption: {
      mode: "process-only",
      evidence: "fake codex stops the process",
    },
    approvals: { available: true, evidence: "fake codex hosts approvals" },
    clarifications: {
      available: false,
      evidence: "fake codex offers no clarifications",
    },
    steer: {
      available: true,
      evidence: "fake codex offers native same-Turn steer",
    },
    modelSelection: {
      at: "unavailable",
      evidence: "fake codex selects no model",
    },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "fake codex mints a thread id",
    },
    skillDelivery: { mode: "plain-path", evidence: "fake codex reads a path" },
    fileDelivery: { mode: "plain-path", evidence: "fake codex reads a path" },
  };
}

const COMPLETED: TurnResult = {
  kind: "completed",
  detail: {
    finalContent: "recorded",
    effectiveModel: { known: true, model: "fake-codex-model" },
    session: { state: "open" },
  },
};

/** The fake Codex script for a fixture. The `approval` case raises one awaited tool
 *  approval that the unattended `allow` policy answers, then the Turn completes; the
 *  `completion` case completes straight away. Both emit a Session event and
 *  authoritative assistant content. */
function codexScript(fixture: string): FakeScript {
  const events: TurnEvent[] = [
    { kind: "session", availability: { state: "open" } },
    { kind: "assistant-content", content: `recorded ${fixture}` },
  ];
  if (fixture === "approval") {
    return {
      profile: codexProfile(),
      turns: [
        {
          events,
          requests: [
            {
              id: "req-approve",
              shape: {
                kind: "approval",
                tool: "Shell",
                input: APPROVAL_PROMPT,
                decisions: APPROVAL_DECISIONS,
              },
              awaited: true,
            },
          ],
          result: COMPLETED,
        },
      ],
    };
  }
  return { profile: codexProfile(), turns: [{ events, result: COMPLETED }] };
}

function writeAgentBundle(prompt: string): { folder: string; id: string } {
  const folder = makeTempDir("secant-codex-headless-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "go.md"), prompt);
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.codex-headless-e2e",
      version: "1.0.0",
      name: "Codex Headless E2E",
      description:
        "A single Agent Step Bundle driven headlessly through Codex.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/go.md", kind: "prompt" }],
    routing: [
      {
        id: "work",
        kind: "agent",
        session: "s",
        prompt: { asset: "prompts/go.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

function wire(
  t: TestContext,
  fixture: string,
  prompt: string,
): { wired: Wiring; bundleId: string; digest: string } {
  const workspace = makeTempDir("secant-codex-headless-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-codex-headless-home-"),
    launchCwd: workspace,
    process: createFakeBundleProcess(),
    codexHarnessAdapter: createFake(codexScript(fixture))(),
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

  const bundle = writeAgentBundle(prompt);
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

test("--harness-requests allow answers a Codex approval; the Run rests succeeded with exit 0 and the frozen JSON shape (#148)", async (t) => {
  const { wired, bundleId, digest } = wire(t, "approval", APPROVAL_PROMPT);

  // The Codex Turn raises one approval; the unattended `allow` policy answers it, so
  // the Run terminates rather than hanging — the same semantics as Claude Code.
  const launched = await headless(wired, [
    "run",
    "launch",
    bundleId,
    "--trust",
    digest,
    "--harness",
    "codex",
    "--harness-requests",
    "allow",
  ]);
  // Exit 0 is the succeeded-rest contract (exitForState); a hung approval would not
  // reach it.
  assert.equal(launched.code, 0, launched.out + launched.err);
  const runId = runIdOf(launched.out);

  const shown = await headless(wired, ["run", "show", runId, "--json"]);
  assert.equal(shown.code, 0, shown.out + shown.err);
  const parsed = JSON.parse(shown.out) as {
    result: { run: { state: string; harness?: { name: string } } };
  };
  // Frozen field: the three-OS CI gate parses `.result.run.state`.
  assert.equal(parsed.result.run.state, "succeeded");
  // Additive Harness-selection evidence: the observed Codex identity, never a native id.
  assert.match(parsed.result.run.harness?.name ?? "", /codex/i);
});

test("an omitted Harness selection for an Agent Bundle is refused with a stable Problem (#148, story 26)", async (t) => {
  const { wired, bundleId, digest } = wire(
    t,
    "completion",
    "Reply with exactly: recorded completion.",
  );
  // No `--harness` for an Agent-bearing routing: refused, never an implicit fallback.
  const launched = await headless(wired, [
    "run",
    "launch",
    bundleId,
    "--trust",
    digest,
  ]);
  assert.notEqual(launched.code, 0);
  assert.match(launched.out + launched.err, /harness/i);
});
