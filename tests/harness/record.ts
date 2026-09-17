// The opt-in Claude Code recorder (#115). It drives a named scenario against the
// installed `claude`, reproducing the exact launch contract Secant's Claude Code
// Adapter builds (src/harness/claude-code.ts `launch`) and an equivalent loopback
// MCP approve-bridge (src/harness/permission-bridge.ts), so the bytes it captures
// on stdout are exactly what the Adapter's `consumeStdout` would read. Per case it
// writes the byte-faithful stdout stream(s), the stdin frame(s) it sent, the bridge
// calls and their ordering relative to stdout, a per-Turn Workspace patch (git diff
// of the scenario Workspace across the Turn), and the `recording.json` sidecar.
//
// It never runs in CI (the default suite is deterministic and Harness-free). Run it
// locally with the installed, logged-in Claude Code:
//
//   bun tests/harness/record.ts <case>        # one case
//   bun tests/harness/record.ts all           # every real case
//
// Cases: plain, test-repair, interrupt, resume, authentication, protocol-corruption,
// matt-front.
// It records with `--restricted` (real login and model, but no personal hooks,
// CLAUDE.md, plugins, or settings) so fixtures are clean and reproducible. The
// authentication case uses a fresh, not-logged-in `CLAUDE_CONFIG_DIR`, so the real
// login is never disturbed. Every host secret is redacted, and the recording is
// refused if any credential pattern survives.

import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  assertNoCredentials,
  envSecrets,
  redact,
  type KnownSecret,
  type Redaction,
} from "./redact.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "claude-code");
const HARNESS = "claude-code";

/** Constant-time bearer comparison (D2), mirroring the production bridge. */
function bearerMatches(
  presented: string | undefined,
  expected: string,
): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Canonical per-case session ids — the same ids the Adapter tests mint, so the
 *  recorded frames echo exactly what a test's `--session-id`/`--resume` carries. */
const SESSION_IDS = {
  plain: "11111111-1111-4111-8111-111111111111",
  "test-repair": "77777777-7777-4777-8777-777777777777",
  interrupt: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  resume: "55555555-5555-4555-8555-555555555555",
  authentication: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  "protocol-corruption": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "matt-front": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

// --- The launch contract (must mirror src/harness/claude-code.ts `launch`) ----

function launchArgs(
  sessionArgs: string[],
  mcpConfigArg: string,
  toolName: string,
): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Recorder-only: `--restricted` keeps the real login and model but drops this
    // host's CLAUDE.md, skills, plugins, hooks, and settings-file MCP, so the
    // recording is clean, reproducible, and free of personal config. It is NOT
    // part of the Adapter's launch contract (the Adapter is deliberately
    // user-compatible); a user-compatible launch merely adds hook/status frames
    // the Adapter treats as generic activity, so the protocol shape is the same.
    "--restricted",
    ...sessionArgs,
    "--mcp-config",
    mcpConfigArg,
    "--permission-prompt-tool",
    toolName,
  ];
}

function userFrame(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  })}\n`;
}

// --- The recorder-local approve-bridge (mirrors permission-bridge.ts) ----------

// ponytail: this bridge intentionally re-implements the shape of
// src/harness/permission-bridge.ts rather than importing it — that module is
// private to the Harness Module and the import-boundary check forbids a test from
// reaching past a Module's public entry. Keep the server name, tool name, and
// allow/deny payload in sync with permission-bridge.ts by hand; if that contract
// changes, update both. The recorded bytes only depend on this matching what
// Claude Code is launched against, which the shared SERVER_NAME/TOOL_NAME ensure.
const SERVER_NAME = "secant-permissions";
const TOOL_NAME = "approve";

interface BridgeCall {
  readonly tool_name: string;
  readonly input: unknown;
  // ponytail: stdout pipe events and the loopback HTTP bridge call are separate
  // event sources with no cross-ordering guarantee, so this offset can under-count
  // stdout still queued when the call fires and split a segment slightly early. It
  // is exact enough in practice (the segment boundary only affects when the replay
  // raises the approval, not the bytes), and a bad split fails the case's replay
  // test loudly. Upgrade to draining stdout on the call if a case ever mis-splits.
  /** Bytes of stdout seen when this call arrived, so stdout can be split around it. */
  readonly stdoutOffset: number;
}

interface RecorderBridge {
  readonly mcpConfigArg: string;
  readonly toolName: string;
  readonly token: string;
  readonly calls: BridgeCall[];
  close(): Promise<void>;
}

/** Start one loopback MCP approve-bridge. `answer` decides each call; `offset`
 *  reports the current stdout byte count so calls can be ordered against stdout. */
function startBridge(
  answer: (call: { tool_name: string; input: unknown }) => {
    behavior: "allow" | "deny";
    message?: string;
  },
  offset: () => number,
): Promise<RecorderBridge> {
  const token = randomBytes(32).toString("hex");
  const authHeader = `Bearer ${token}`;
  const calls: BridgeCall[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Set<McpServer>();

  const build = (): McpServer => {
    const server = new McpServer({ name: SERVER_NAME, version: "1.0.0" });
    server.registerTool(
      TOOL_NAME,
      {
        description: "Secant permission bridge (recorder).",
        inputSchema: {
          tool_name: z.string(),
          input: z.unknown().optional(),
          tool_use_id: z.string().optional(),
        },
      },
      async (args) => {
        calls.push({
          tool_name: args.tool_name,
          input: args.input ?? {},
          stdoutOffset: offset(),
        });
        const verdict = answer({
          tool_name: args.tool_name,
          input: args.input,
        });
        const payload =
          verdict.behavior === "allow"
            ? { behavior: "allow", updatedInput: args.input ?? {} }
            : { behavior: "deny", message: verdict.message ?? "denied" };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        };
      },
    );
    return server;
  };

  const http: Server = createServer((req, res) => {
    if (!bearerMatches(req.headers.authorization, authHeader)) {
      res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const id = sessionIdOf(req);
    const existing = id === undefined ? undefined : sessions.get(id);
    if (existing !== undefined) {
      void existing
        .handleRequest(req, res)
        .catch(() => res.writeHead(500).end());
      return;
    }
    if (id !== undefined) {
      res.writeHead(404).end(JSON.stringify({ error: "unknown session" }));
      return;
    }
    const server = build();
    servers.add(server);
    const transport: StreamableHTTPServerTransport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString("hex"),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, transport);
        },
      });
    transport.onclose = () => {
      if (transport.sessionId !== undefined)
        sessions.delete(transport.sessionId);
      servers.delete(server);
      void server.close().catch(() => {});
    };
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => res.writeHead(500).end());
  });

  return new Promise<RecorderBridge>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.removeListener("error", reject);
      const address = http.address();
      if (address === null || typeof address === "string") {
        reject(new Error("bridge did not bind a loopback port"));
        return;
      }
      const mcpConfigArg = JSON.stringify({
        mcpServers: {
          [SERVER_NAME]: {
            type: "http",
            url: `http://127.0.0.1:${address.port}/mcp`,
            headers: { Authorization: authHeader },
          },
        },
      });
      resolve({
        mcpConfigArg,
        toolName: `mcp__${SERVER_NAME}__${TOOL_NAME}`,
        token,
        calls,
        close: () =>
          new Promise<void>((done) => {
            for (const t of sessions.values()) void t.close().catch(() => {});
            http.close(() => done());
          }),
      });
    });
  });
}

function sessionIdOf(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

// --- Spawning and capturing a real Turn ---------------------------------------

interface Capture {
  /** The raw stdout bytes, exactly as they arrived. */
  readonly stdout: Buffer;
  /** The raw stderr bytes. */
  readonly stderr: Buffer;
  readonly exitCode: number;
}

interface RunControl {
  /** Called with the child and the growing stdout buffer on each chunk, so a
   *  scenario can interrupt or force-kill at a chosen point. Resolves the returned
   *  promise to stop waiting for a natural exit (the child is left to the caller). */
  onChunk?: (
    child: ChildProcessWithoutNullStreams,
    stdout: Buffer,
    chunk: Buffer,
  ) => void;
}

/** Spawn `claude` with the given argv, write one user frame, and capture raw
 *  streams until the process exits (or a control stops it). */
function runTurn(options: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  control?: RunControl;
}): Promise<Capture> {
  const child = spawn("claude", options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
    options.control?.onChunk?.(child, stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]);
  });
  child.stdin.write(options.input);
  // Close stdin after the one frame so `claude -p` finishes the single Turn and
  // exits (it otherwise blocks waiting for more stream-json frames). The current
  // Turn still runs to completion, so interrupt/corruption scenarios kill it
  // mid-flight before it settles.
  child.stdin.end();
  return new Promise<Capture>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (signal ? 128 + signalNumber(signal) : 0),
      });
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 0;
}

// --- Writing a case directory -------------------------------------------------

function baseEnv(): NodeJS.ProcessEnv {
  // Keep the real config dir so the OS-keychain login applies (a copied or fresh
  // config dir is treated as a new install and is not logged in). Cleanliness
  // comes from `--restricted`, not config isolation. Drop any API key so OAuth is
  // used — except the authentication scenario, which sets a bad one deliberately.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function hostSecrets(bridgeToken?: string): KnownSecret[] {
  const secrets: KnownSecret[] = [
    { value: homedir(), placeholder: "«HOME»", reason: "home directory" },
    { value: userInfo().username, placeholder: "«USER»", reason: "user name" },
    // Any secret-shaped environment variable on the recording host, so a value
    // the scenario never named is still redacted before the bytes are written.
    ...envSecrets(),
  ];
  if (bridgeToken !== undefined) {
    secrets.push({
      value: bridgeToken,
      placeholder: "«BRIDGE_TOKEN»",
      reason: "MCP permission bridge bearer token",
    });
  }
  return secrets;
}

interface WriteFile {
  readonly name: string;
  readonly bytes: Buffer;
}

/** Drop `stream_event` frames carrying `input_json_delta` (streamed tool-input),
 *  preserving every other line's exact bytes. Unparseable lines (e.g. a truncated
 *  corruption frame) are kept as-is. */
function dropToolInputDeltas(text: string): {
  text: string;
  dropped: boolean;
} {
  let dropped = false;
  const kept = text.split("\n").filter((line) => {
    if (!line.trimStart().startsWith("{")) return true;
    try {
      const frame = JSON.parse(line) as {
        type?: unknown;
        event?: { delta?: { type?: unknown } };
      };
      if (
        frame.type === "stream_event" &&
        frame.event?.delta?.type === "input_json_delta"
      ) {
        dropped = true;
        return false;
      }
    } catch {
      // Keep a line that is not valid JSON (a deliberately truncated frame).
    }
    return true;
  });
  return { text: kept.join("\n"), dropped };
}

/** Every host-machine path form to redact: the temp directory and its realpath
 *  (macOS tmpdir is a `/var/folders` symlink to `/private/var/folders`, and the
 *  init frame's `cwd` reports the resolved form). */
function pathSecrets(
  path: string | undefined,
  placeholder: string,
  reason: string,
): KnownSecret[] {
  if (path === undefined) return [];
  const real = (() => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  })();
  return [...new Set([path, real])].map((value) => ({
    value,
    placeholder,
    reason,
  }));
}

/** Redact every file's bytes AND `case.json` (a recorded bridge input can carry a
 *  path or, in a future scenario, a secret), refuse on a surviving credential, then
 *  write the case directory with the six-field `recording.json` sidecar. */
function writeCase(options: {
  name: string;
  files: WriteFile[];
  caseJson: unknown;
  secrets: KnownSecret[];
  executableVersion: string;
  protocolVersion: string;
  extraRedactions?: Redaction[];
  /** The scenario's temp Workspace, redacted from stdout and case.json. */
  workspace?: string;
  /** The scenario's temp config dir, redacted (the authentication case). */
  configDir?: string;
}): void {
  const dir = join(FIXTURES, options.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Machine paths are redacted from every artefact, so a committed fixture never
  // carries the recording host's directory layout.
  const secrets: KnownSecret[] = [
    ...pathSecrets(
      options.workspace,
      "«WORKSPACE»",
      "recording workspace path",
    ),
    ...pathSecrets(options.configDir, "«CONFIG»", "recording config directory"),
    ...options.secrets,
  ];
  const applied: Redaction[] = [...(options.extraRedactions ?? [])];
  const mergeRedactions = (redactions: Redaction[]) => {
    for (const entry of redactions) {
      if (!applied.some((a) => a.placeholder === entry.placeholder))
        applied.push(entry);
    }
  };
  for (const file of options.files) {
    // Drop streamed tool-input JSON deltas first: the Adapter never consumes them
    // (only text deltas feed previews), and they stream a tool's input path
    // character by character, fragmenting it past any substring redaction.
    const filtered = dropToolInputDeltas(file.bytes.toString("utf8"));
    if (filtered.dropped) {
      mergeRedactions([
        {
          placeholder: "«TOOL-INPUT-DELTAS»",
          reason:
            "streamed tool-input JSON deltas removed (not consumed by the Adapter; they fragment host paths past substring redaction)",
        },
      ]);
    }
    const { text, redactions } = redact(filtered.text, secrets);
    assertNoCredentials(text);
    mergeRedactions(redactions);
    writeFileSync(join(dir, file.name), text);
  }
  const caseJson = redact(
    `${JSON.stringify(options.caseJson, null, 2)}\n`,
    secrets,
  );
  assertNoCredentials(caseJson.text);
  mergeRedactions(caseJson.redactions);
  writeFileSync(join(dir, "case.json"), caseJson.text);
  writeFileSync(
    join(dir, "recording.json"),
    `${JSON.stringify(
      {
        harness: HARNESS,
        executableVersion: options.executableVersion,
        protocolVersion: options.protocolVersion,
        recordedAt: new Date().toISOString(),
        redactions: applied,
        refreshCommand: `bun tests/harness/record.ts ${options.name}`,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `recorded ${options.name}: ${options.files.map((f) => f.name).join(", ")}`,
  );
}

function claudeVersion(): string {
  return execFileSync("claude", ["--version"]).toString().trim();
}

/** The `claude_code_version` reported in an init frame, or a fallback. */
function protocolVersionOf(stdout: Buffer): string {
  const match = stdout
    .toString("utf8")
    .match(/"claude_code_version":"([^"]+)"/);
  return match?.[1] ?? "unknown";
}

function tempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// --- Scenarios ----------------------------------------------------------------

async function recordPlain(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => 0,
  );
  try {
    const capture = await runTurn({
      args: launchArgs(
        ["--session-id", SESSION_IDS.plain],
        bridge.mcpConfigArg,
        bridge.toolName,
      ),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "Reply with exactly the single word: hello. Do not use any tools.",
      ),
    });
    writeCase({
      name: "plain",
      files: [{ name: "turn-1.stdout", bytes: capture.stdout }],
      caseJson: {
        exitCode: capture.exitCode,
        turns: [{ stdout: "turn-1.stdout" }],
      },
      workspace: ws,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(capture.stdout),
    });
  } finally {
    await bridge.close();
    rmSync(ws, { recursive: true, force: true });
  }
}

async function recordTestRepair(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  // A minimal git Workspace with one failing test: sum() returns the wrong value.
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["config", "user.email", "rec@secant.test"], { cwd: ws });
  execFileSync("git", ["config", "user.name", "recorder"], { cwd: ws });
  writeFileSync(join(ws, "sum.mjs"), "export const sum = (a, b) => a - b;\n");
  writeFileSync(
    join(ws, "sum.test.mjs"),
    [
      "import assert from 'node:assert';",
      "import { sum } from './sum.mjs';",
      "assert.equal(sum(2, 3), 5);",
      "console.log('sum ok');",
    ].join("\n") + "\n",
  );
  execFileSync("git", ["add", "-A"], { cwd: ws });
  execFileSync("git", ["commit", "-q", "-m", "failing baseline"], { cwd: ws });

  let stdoutLen = 0;
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => stdoutLen,
  );
  try {
    const capture = await runTurn({
      args: launchArgs(
        ["--session-id", SESSION_IDS["test-repair"]],
        bridge.mcpConfigArg,
        bridge.toolName,
      ),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "The test in sum.test.mjs fails. Fix the bug in sum.mjs so `node sum.test.mjs` passes. Edit sum.mjs; do not edit the test.",
      ),
      control: { onChunk: (_child, stdout) => (stdoutLen = stdout.length) },
    });
    // The Workspace patch across the Turn.
    const patch = execFileSync("git", ["diff"], { cwd: ws }).toString();
    if (patch.trim().length === 0) {
      throw new Error("test-repair: no Workspace change was produced");
    }
    // Split the captured stdout around each bridge call so, on replay, the bytes
    // after a permission prompt emit only once the verdict is in.
    const files: WriteFile[] = [];
    const steps: unknown[] = [];
    let cursor = 0;
    bridge.calls.forEach((call, index) => {
      const segment = capture.stdout.subarray(cursor, call.stdoutOffset);
      const name = `stdout-${index}.stdout`;
      files.push({ name, bytes: segment });
      steps.push({ emit: name });
      steps.push({ bridge: { tool_name: call.tool_name, input: call.input } });
      cursor = call.stdoutOffset;
    });
    const tail = capture.stdout.subarray(cursor);
    files.push({ name: "stdout-final.stdout", bytes: tail });
    steps.push({ emit: "stdout-final.stdout" });

    writeCase({
      name: "test-repair",
      files: [
        ...files,
        { name: "workspace.patch", bytes: Buffer.from(patch, "utf8") },
      ],
      caseJson: {
        exitCode: capture.exitCode,
        turns: [{ steps, workspacePatch: "workspace.patch" }],
      },
      workspace: ws,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(capture.stdout),
    });
  } finally {
    await bridge.close();
    rmSync(ws, { recursive: true, force: true });
  }
}

/** Record a Turn that emits its session then is interrupted mid-flight. */
async function recordInterrupt(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => 0,
  );
  try {
    const capture = await runTurn({
      args: launchArgs(
        ["--session-id", SESSION_IDS.interrupt],
        bridge.mcpConfigArg,
        bridge.toolName,
      ),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "Write a long slow essay about the number seven, at least 500 words, using no tools. Take your time.",
      ),
      control: {
        onChunk: (child, stdout) => {
          // Once init and some assistant streaming has been observed, SIGTERM — the
          // same graceful stop the Adapter's interrupt performs.
          if (
            stdout.includes('"subtype":"init"') &&
            stdout.includes('"text_delta"') &&
            !child.killed
          ) {
            child.kill("SIGTERM");
          }
        },
      },
    });
    writeCase({
      name: "interrupt",
      files: [{ name: "turn-1.stdout", bytes: capture.stdout }],
      caseJson: {
        exitCode: capture.exitCode,
        turns: [{ stdout: "turn-1.stdout" }],
      },
      workspace: ws,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(capture.stdout),
    });
  } finally {
    await bridge.close();
    rmSync(ws, { recursive: true, force: true });
  }
}

/** Record a detached Session resumed by id: interrupt turn 1, resume in turn 2. */
async function recordResume(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => 0,
  );
  try {
    const first = await runTurn({
      args: launchArgs(
        ["--session-id", SESSION_IDS.resume],
        bridge.mcpConfigArg,
        bridge.toolName,
      ),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "Write a long slow essay about the number nine, at least 500 words, using no tools.",
      ),
      control: {
        onChunk: (child, stdout) => {
          if (
            stdout.includes('"subtype":"init"') &&
            stdout.includes('"text_delta"') &&
            !child.killed
          ) {
            child.kill("SIGTERM");
          }
        },
      },
    });
    const second = await runTurn({
      args: launchArgs(
        ["--resume", SESSION_IDS.resume],
        bridge.mcpConfigArg,
        bridge.toolName,
      ),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "Never mind. Reply with exactly: resumed. Use no tools.",
      ),
    });
    writeCase({
      name: "resume",
      files: [
        { name: "initial.stdout", bytes: first.stdout },
        { name: "resume.stdout", bytes: second.stdout },
      ],
      caseJson: {
        exitCode: first.exitCode,
        turns: [{ stdout: "initial.stdout" }],
        resume: {
          exitCode: second.exitCode,
          turns: [{ stdout: "resume.stdout" }],
        },
      },
      workspace: ws,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(second.stdout),
    });
  } finally {
    await bridge.close();
    rmSync(ws, { recursive: true, force: true });
  }
}

/** Record the real not-logged-in result. A fresh, empty `CLAUDE_CONFIG_DIR` is not
 *  logged in, so `claude -p` returns the remediation immediately — the real login in
 *  the OS keychain is never touched, and no credential is fed in (so nothing to leak).
 *  The recording pins the actual signal: the not-logged-in result arrives as
 *  `subtype:"success"` with `result:"Not logged in · Please run /login"`, not an error
 *  subtype — the fact this ticket exists to confirm. */
async function recordAuthentication(): Promise<void> {
  const config = tempWorkspace("secant-rec-cfg-");
  const ws = tempWorkspace("secant-rec-ws-");
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => 0,
  );
  const env = baseEnv();
  env.CLAUDE_CONFIG_DIR = config;
  try {
    const capture = await runTurn({
      args: launchArgs(
        ["--session-id", SESSION_IDS.authentication],
        bridge.mcpConfigArg,
        bridge.toolName,
      ),
      cwd: ws,
      env,
      input: userFrame("Reply with exactly: hello."),
    });
    writeCase({
      name: "authentication",
      files: [{ name: "turn-1.stdout", bytes: capture.stdout }],
      caseJson: {
        exitCode: capture.exitCode,
        turns: [{ stdout: "turn-1.stdout", exitAfter: true }],
      },
      workspace: ws,
      configDir: config,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(capture.stdout),
    });
  } finally {
    await bridge.close();
    rmSync(config, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

/** Record a genuine truncated JSON frame: capture a real init, then force-kill the
 *  process while a later frame is mid-write, leaving a frame with no terminating
 *  newline — exactly the transport corruption the Adapter detects. */
async function recordProtocolCorruption(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => 0,
  );
  try {
    const capture = await runTurn({
      args: launchArgs(
        ["--session-id", SESSION_IDS["protocol-corruption"]],
        bridge.mcpConfigArg,
        bridge.toolName,
      ),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "Write a long slow essay about the number three, at least 500 words, using no tools.",
      ),
      control: {
        onChunk: (child, stdout) => {
          // SIGKILL once init and a few streaming frames have been captured, giving
          // real material to truncate. The OS delivers whole frames, so the mid-write
          // truncation itself is applied deterministically below rather than raced.
          const text = stdout.toString("utf8");
          if (
            text.includes('"subtype":"init"') &&
            (text.match(/\n/g)?.length ?? 0) >= 4 &&
            !child.killed
          ) {
            child.kill("SIGKILL");
          }
        },
      },
    });
    // Model the mid-write SIGKILL: keep every complete captured frame (all real
    // bytes, init included), then re-emit the last frame truncated to half its
    // length with no terminating newline — exactly the truncated JSON frame the
    // Adapter's end-of-stream check detects as protocol corruption.
    const raw = capture.stdout.toString("utf8");
    const complete = raw.split("\n").filter((line) => line.length > 0);
    if (complete.length < 2 || !raw.includes('"subtype":"init"')) {
      throw new Error(
        "protocol-corruption: captured too little to truncate; re-run",
      );
    }
    const keep = complete.slice(0, -1);
    const last = complete[complete.length - 1]!;
    const truncatedTail = last.slice(
      0,
      Math.max(1, Math.floor(last.length / 2)),
    );
    const bytes = Buffer.from(
      keep.map((line) => `${line}\n`).join("") + truncatedTail,
      "utf8",
    );
    writeCase({
      name: "protocol-corruption",
      files: [{ name: "turn-1.stdout", bytes }],
      caseJson: {
        exitCode: 0,
        turns: [{ stdout: "turn-1.stdout", exitAfter: true }],
      },
      workspace: ws,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(bytes),
      extraRedactions: [
        {
          placeholder: "«TRUNCATED»",
          reason:
            "trailing frame left incomplete by a mid-write SIGKILL (a real transport truncation)",
        },
      ],
    });
  } finally {
    await bridge.close();
    rmSync(ws, { recursive: true, force: true });
  }
}

/** Record the Matt front Bundle's Harness Turns (#123): a two-Turn interactive
 *  grill and the autonomous spec Turn, all in one Session. The grill's first Turn
 *  mints the Session (`--session-id`); every later Turn resumes it (`--resume`),
 *  exactly as the Adapter drives a fresh prepared Harness per human Turn and then
 *  the following Agent Step. The spec Turn writes `specs/spec.md` through one real
 *  permission-bridge approval, and its Workspace patch is the created file. The
 *  replayer serves the two resumed processes their own Turn from the resume block. */
async function recordMattFront(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  // A git Workspace so the created spec file is captured as a `git apply`-able patch.
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["config", "user.email", "rec@secant.test"], { cwd: ws });
  execFileSync("git", ["config", "user.name", "recorder"], { cwd: ws });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "baseline"], {
    cwd: ws,
  });

  const sid = SESSION_IDS["matt-front"];
  let stdoutLen = 0;
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => stdoutLen,
  );
  try {
    // Grill Turn 1 mints the Session. Bounded replies keep the fixture small; the
    // grill prompt itself is not sent for an interactive Step in v1 (the human
    // drives every Turn), so the frame text sets up the interview.
    const grill1 = await runTurn({
      args: launchArgs(
        ["--session-id", sid],
        bridge.mcpConfigArg,
        bridge.toolName,
      ),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "Let's design a feature together. I want to add a dark-mode toggle to " +
          "our web app's settings page. Interview me: ask exactly one short " +
          "question about it, under 40 words. Do not write any files.",
      ),
    });
    // Grill Turn 2 resumes the same Session and concludes the interview.
    const grill2 = await runTurn({
      args: launchArgs(["--resume", sid], bridge.mcpConfigArg, bridge.toolName),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "The toggle should persist per-user in their profile and default to the " +
          "system setting. That is enough context. In under 30 words, confirm " +
          "you have what you need. Do not ask more questions or write files.",
      ),
    });

    // Spec Turn resumes the Session and writes the one file through an approval.
    stdoutLen = 0;
    const callsBefore = bridge.calls.length;
    const spec = await runTurn({
      args: launchArgs(["--resume", sid], bridge.mcpConfigArg, bridge.toolName),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "Now write the spec. Using the Write tool, create the file " +
          "specs/spec.md containing a short (under 200 words) Markdown spec for " +
          "the dark-mode toggle we discussed. Write only that one file.",
      ),
      control: { onChunk: (_child, stdout) => (stdoutLen = stdout.length) },
    });
    // Stage the created file so the diff is a `git apply`-able new-file patch.
    execFileSync("git", ["add", "-A"], { cwd: ws });
    const patch = execFileSync("git", ["diff", "--cached"], {
      cwd: ws,
    }).toString();
    if (patch.trim().length === 0) {
      throw new Error("matt-front: the spec Turn wrote no file");
    }

    // Split the spec Turn's stdout around each bridge call, as test-repair does,
    // so recorded bytes after a permission prompt emit only once the verdict is in.
    const specCalls = bridge.calls.slice(callsBefore);
    const specFiles: WriteFile[] = [];
    const specSteps: unknown[] = [];
    let cursor = 0;
    specCalls.forEach((call, index) => {
      specFiles.push({
        name: `spec-${index}.stdout`,
        bytes: spec.stdout.subarray(cursor, call.stdoutOffset),
      });
      specSteps.push({ emit: `spec-${index}.stdout` });
      specSteps.push({
        bridge: { tool_name: call.tool_name, input: call.input },
      });
      cursor = call.stdoutOffset;
    });
    specFiles.push({
      name: "spec-final.stdout",
      bytes: spec.stdout.subarray(cursor),
    });
    specSteps.push({ emit: "spec-final.stdout" });

    writeCase({
      name: "matt-front",
      files: [
        { name: "grill-1.stdout", bytes: grill1.stdout },
        { name: "grill-2.stdout", bytes: grill2.stdout },
        ...specFiles,
        { name: "workspace.patch", bytes: Buffer.from(patch, "utf8") },
      ],
      caseJson: {
        exitCode: grill1.exitCode,
        turns: [{ stdout: "grill-1.stdout" }],
        resume: {
          exitCode: spec.exitCode,
          turns: [
            { stdout: "grill-2.stdout" },
            { steps: specSteps, workspacePatch: "workspace.patch" },
          ],
        },
      },
      workspace: ws,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(grill1.stdout),
    });
  } finally {
    await bridge.close();
    rmSync(ws, { recursive: true, force: true });
  }
}

const RECORDERS: Record<string, () => Promise<void>> = {
  plain: recordPlain,
  "test-repair": recordTestRepair,
  interrupt: recordInterrupt,
  resume: recordResume,
  authentication: recordAuthentication,
  "protocol-corruption": recordProtocolCorruption,
  "matt-front": recordMattFront,
};

async function main(): Promise<void> {
  const which = process.argv[2];
  if (which === undefined) {
    console.error(
      `usage: bun tests/harness/record.ts <${Object.keys(RECORDERS).join("|")}|all>`,
    );
    process.exit(2);
  }
  // Fail fast if Claude Code is not installed.
  if (spawnSync("claude", ["--version"]).status !== 0) {
    console.error(
      "record.ts needs an installed, logged-in Claude Code on PATH",
    );
    process.exit(2);
  }
  const names = which === "all" ? Object.keys(RECORDERS) : [which];
  for (const name of names) {
    const recorder = RECORDERS[name];
    if (recorder === undefined) {
      console.error(`unknown case '${name}'`);
      process.exit(2);
    }
    await recorder();
  }
}

await main();
