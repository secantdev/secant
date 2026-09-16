// The Claude Code Adapter (#111): discovery, non-conversational qualification,
// the evidence-bearing profile, and the qualification cache. The shared
// prepare/profile conformance cases run against it over the real replayer,
// which keeps the fake honest; the cases below cover the Claude-Code-specific
// facts the shared suite does not — discovery order and refusals, the M3 profile
// facts and posture, that no forbidden flag or stdin content is ever built, and
// cache reuse versus requalification on drift.

import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  createClaudeCodeAdapter,
} from "../../src/harness/harness.js";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  runPrepareProfileCases,
  type PrepareProfileScenarios,
} from "./conformance.js";
import { installReplayer } from "./replayer.js";

const VERSION = "2.1.234 (Claude Code)";
const FORBIDDEN_FLAGS = [
  "--bare",
  "--strict-mcp-config",
  "--allowedTools",
  "--tools",
  "--model",
  "--permission-mode",
  "--session-id",
  "--resume",
];

// --- Shared conformance cases over the real replayer -------------------------

const conformanceReplayer = installReplayer(VERSION);
const scenarios: PrepareProfileScenarios = {
  label: "claude-code",
  baseline: () => () =>
    createClaudeCodeAdapter({ path: conformanceReplayer.path, env: {} }),
  prepareFailure: () => () =>
    createClaudeCodeAdapter({
      path: makeTempDir("secant-claude-empty-"),
      env: {},
    }),
};
runPrepareProfileCases(scenarios);

// --- Discovery ---------------------------------------------------------------

test("the configured env var is used first and reported in the profile", async () => {
  const replayer = installReplayer(VERSION);
  const adapter = createClaudeCodeAdapter({
    // Real PATH only (no replayer `claude` on it), so the interpreter still
    // resolves on Windows and the env var is provably what discovery uses.
    path: process.env.PATH ?? "",
    env: { [CLAUDE_CODE_EXECUTABLE_ENV]: replayer.executablePath },
  });
  const result = await adapter.prepare({});
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.match(result.harness.profile.executable, /configured command/);
  assert.equal(result.harness.profile.executableVersion, VERSION);
});

test("the caller's configuredExecutable option is honoured", async () => {
  const replayer = installReplayer(VERSION);
  const adapter = createClaudeCodeAdapter({
    path: process.env.PATH ?? "",
    env: {},
  });
  const result = await adapter.prepare({
    configuredExecutable: replayer.executablePath,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.match(result.harness.profile.executable, /configured command/);
});

test("a configured command wins over a `claude` found on PATH", async () => {
  const onPath = installReplayer("1.0.0 (Claude Code)");
  const configured = installReplayer("2.0.0 (Claude Code)");
  const adapter = createClaudeCodeAdapter({
    path: onPath.path,
    env: { [CLAUDE_CODE_EXECUTABLE_ENV]: configured.executablePath },
  });
  const result = await adapter.prepare({});
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.harness.profile.executableVersion, "2.0.0 (Claude Code)");
});

test("with neither configured nor on PATH, prepare fails not-found naming both", async () => {
  const adapter = createClaudeCodeAdapter({
    path: makeTempDir("secant-claude-empty-"),
    env: { [CLAUDE_CODE_EXECUTABLE_ENV]: "definitely-not-a-real-command-xyz" },
  });
  const result = await adapter.prepare({});
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.phase, "prepare");
  assert.equal(result.failure.category, "not-found");
  assert.match(
    result.failure.diagnostics ?? "",
    /definitely-not-a-real-command-xyz/,
  );
  assert.match(result.failure.diagnostics ?? "", /PATH name 'claude'/);
});

test("a Windows shim the resolver cannot parse is an unsupported-shim failure", async () => {
  // Driven cross-OS through the injected platform and resolver, exactly as the
  // process Module drives its own shim tests.
  const dir = makeTempDir("secant-claude-bat-");
  const batPath = join(dir, "claude.bat");
  writeFileSync(batPath, "@echo off\r\necho not a node shim\r\n");
  const adapter = createClaudeCodeAdapter({
    platform: "win32",
    resolve: (name) => (name === "claude" ? batPath : undefined),
    env: {},
  });
  const result = await adapter.prepare({});
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "unsupported-shim");
  assert.match(
    result.failure.diagnostics ?? "",
    new RegExp(batPath.replace(/\\/g, "\\\\")),
  );
});

// --- The M3 profile ----------------------------------------------------------

test("the profile carries every M3 fact with its evidence and a user-compatible posture", async () => {
  const replayer = installReplayer(VERSION);
  const adapter = createClaudeCodeAdapter({ path: replayer.path, env: {} });
  const result = await adapter.prepare({});
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const { profile } = result.harness;

  assert.equal(profile.harness, "claude-code");
  assert.equal(profile.executableVersion, VERSION);
  assert.equal(profile.adapterRevision, "claude-code-1");
  assert.equal(
    profile.platform,
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : "linux",
  );
  // shim-vs-native matches the observed executable.
  assert.match(
    profile.executable,
    process.platform === "win32" ? /npm shim/ : /native/,
  );

  assert.equal(profile.recovery.mode, "native-reattach");
  assert.equal(profile.interruption.mode, "process-only");
  assert.equal(profile.approvals.available, true);
  assert.equal(profile.clarifications.available, false);
  assert.equal(profile.modelSelection.at, "unavailable");
  assert.equal(profile.recoveryCoordinate.timing, "before-submission");
  assert.equal(profile.skillDelivery.mode, "plain-path");
  assert.equal(profile.fileDelivery.mode, "plain-path");

  for (const capability of [
    profile.recovery,
    profile.interruption,
    profile.approvals,
    profile.clarifications,
    profile.modelSelection,
    profile.recoveryCoordinate,
    profile.skillDelivery,
    profile.fileDelivery,
  ]) {
    assert.ok(capability.evidence.length > 0);
  }

  assert.match(profile.configurationPosture, /user-compatible/);
  for (const flag of ["--bare", "--allowedTools", "--tools", "--model"]) {
    assert.match(profile.configurationPosture, new RegExp(flag));
  }
});

test("prepare builds only `--version`, no forbidden flag, and writes nothing to stdin", async () => {
  const replayer = installReplayer(VERSION);
  const adapter = createClaudeCodeAdapter({ path: replayer.path, env: {} });
  const result = await adapter.prepare({});
  assert.equal(result.ok, true);

  const invocations = replayer.invocations();
  assert.equal(invocations.length, 1);
  const [invocation] = invocations;
  assert.deepEqual(invocation.args, ["--version"]);
  assert.equal(invocation.stdinBytes, 0);
  for (const flag of FORBIDDEN_FLAGS) {
    assert.ok(!invocation.args.includes(flag), `argv must not include ${flag}`);
  }
});

// --- Qualification cache -----------------------------------------------------

test("a second prepare reuses the cache; drift requalifies", async () => {
  const replayer = installReplayer(VERSION);
  const adapter = createClaudeCodeAdapter({ path: replayer.path, env: {} });

  const first = await adapter.prepare({});
  const second = await adapter.prepare({});
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) throw new Error("unreachable");
  // Same path, version, and file identity: the probe ran once and was reused.
  assert.equal(replayer.invocations().length, 1);
  assert.equal(second.harness.profile.executableVersion, VERSION);

  replayer.drift("9.9.9 (Claude Code)");
  const third = await adapter.prepare({});
  assert.equal(third.ok, true);
  if (!third.ok) throw new Error("unreachable");
  // The file identity drifted: the Adapter requalified.
  assert.equal(replayer.invocations().length, 2);
  assert.equal(third.harness.profile.executableVersion, "9.9.9 (Claude Code)");
});

// --- Version-probe failure (POSIX; the mapping itself is OS-agnostic) --------

test(
  "a non-zero `--version` exit is a typed version-probe failure",
  { skip: process.platform === "win32" },
  async () => {
    const dir = makeTempDir("secant-claude-broken-");
    const broken = join(dir, "claude");
    writeFileSync(broken, "#!/bin/sh\necho boom 1>&2\nexit 4\n");
    chmodSync(broken, 0o755);
    const adapter = createClaudeCodeAdapter({ path: dir, env: {} });
    const result = await adapter.prepare({});
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.failure.category, "version-probe");
    assert.equal(result.failure.nativeCode, "4");
  },
);
