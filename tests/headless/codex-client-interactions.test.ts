import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import { createCodexAdapter } from "../../src/harness/harness.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import { installCodexReplayer } from "../harness/codex-replayer.js";
import { ensureRuntimeOnPath } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The headless client drives a selected Codex Run through the same contract as Claude
// Code (#148, spec stories 28–34): the `--harness-requests` policy answers Codex
// approvals, the exit code follows the rest state, and the frozen `--json` fields are
// unchanged with only additive Harness-selection evidence. Driven against a recorded
// Codex app-server replayer (no real Harness, ADR 0027).

ensureRuntimeOnPath();

const APPROVAL_PROMPT =
  "Run `touch /tmp/secant-codex-recording-approval` now. Do not do anything else.";

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
  const replayer = installCodexReplayer(fixture);
  const workspace = makeTempDir("secant-codex-headless-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-codex-headless-home-"),
    launchCwd: workspace,
    codexHarnessAdapter: createCodexAdapter({ path: replayer.path, env: {} }),
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
