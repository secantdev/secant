#!/usr/bin/env bun
// The `claude` replayer (#111/#112). It stands in for a real Claude Code
// executable so the Adapter's discovery, shim resolution, and spawning run for
// real in CI on all three OSes — never a fake in place of a spawn. A test drops
// it on a temporary PATH under the name `claude` (a chmod'd shebang script on
// POSIX; an npm-style `.cmd` shim naming the Bun runtime plus this script on
// Windows) and spawns it directly. It parses argv, answers `--version`, then for
// a Turn case waits for each stdin frame before emitting that Turn's recorded
// stdout/stderr bytes. This preserves the real process and backpressure seam.
//
// It records argv, cwd, and each intact stdin line to the log named in its
// runtime configuration. The protocol case itself is a directory outside the
// recorded-fixture tree; #115 replaces these hand-authored cases with recordings.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const scriptDir = dirname(process.argv[1]);
const recording = JSON.parse(
  readFileSync(join(scriptDir, "recording.json"), "utf8"),
);
const args = process.argv.slice(2);
const invocationId = `${process.pid}-${Date.now()}`;

// SIGTERM ends the Turn and the process (exit 143), matching real `claude -p`. It
// is installed at startup so an interrupt — which only ever arrives after the Turn
// is live — never races the handler. A case may swap this for a swallow below to
// model a process that ignores SIGTERM and must be force-killed.
process.on("SIGTERM", () => process.exit(143));

if (recording.log) {
  appendFileSync(
    recording.log,
    JSON.stringify({
      type: "start",
      id: invocationId,
      args,
      cwd: process.cwd(),
    }) + "\n",
  );
}

if (args.includes("--version")) {
  process.stdout.write(recording.version + "\n");
  process.exit(0);
}

const caseDirectory = recording.protocolCaseDirectory;
if (typeof caseDirectory !== "string") {
  process.stderr.write("secant replayer: no protocol case configured\n");
  process.exit(2);
}

const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

// The MCP permission bridge Secant launched us against: its loopback URL and
// bearer come from the `--mcp-config` argv, the tool name from
// `--permission-prompt-tool`. Connected lazily; only bridge steps need it.
const permissionTool = valueAfter("--permission-prompt-tool");
const bridge = parseBridge(valueAfter("--mcp-config"));
// Claude addresses the tool as `mcp__<server>__<tool>` via --permission-prompt-tool,
// but over the MCP protocol the server exposes it under its bare registered name.
// Strip the `mcp__<server>__` prefix (the server name is the mcp-config key).
const bridgeTool =
  bridge && permissionTool
    ? permissionTool.replace(`mcp__${bridge.name}__`, "")
    : permissionTool;

function parseBridge(raw) {
  if (typeof raw !== "string") return undefined;
  try {
    const config = JSON.parse(raw);
    const [name, entry] = Object.entries(config.mcpServers ?? {})[0] ?? [];
    if (!entry || typeof entry.url !== "string") return undefined;
    return {
      name,
      url: entry.url,
      authorization: entry.headers?.Authorization,
    };
  } catch {
    return undefined;
  }
}

let mcpClient;
let connecting;
// One shared client/session for the whole invocation. Memoize the connect
// promise, not the resolved client, so concurrent bridge steps await the same
// connection instead of racing to open a second session the transport can't hold.
function connectBridge() {
  if (!connecting) {
    connecting = (async () => {
      const { Client } = await import(recording.mcpClientModule);
      const { StreamableHTTPClientTransport } = await import(
        recording.mcpTransportModule
      );
      const client = new Client({ name: "secant-replayer", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: bridge.authorization
          ? { headers: { Authorization: bridge.authorization } }
          : undefined,
      });
      await client.connect(transport);
      mcpClient = client;
      return client;
    })();
  }
  return connecting;
}

// Perform one recorded permission call: invoke the bridge tool with the recorded
// tool name and input, block until Secant answers, then record and return the
// verdict. A deny "request expired" means the Turn was torn down under us — stop
// as Claude Code would when its permission call is refused.
async function bridgeCall(spec) {
  let payload;
  try {
    const client = await connectBridge();
    const result = await client.callTool({
      name: bridgeTool,
      arguments: { tool_name: spec.tool_name, input: spec.input },
    });
    const text = result?.content?.[0]?.text;
    payload = text ? JSON.parse(text) : { behavior: "unknown" };
  } catch (error) {
    payload = { behavior: "error", message: String(error) };
  }
  if (recording.log) {
    appendFileSync(
      recording.log,
      JSON.stringify({
        type: "bridge",
        id: invocationId,
        tool_name: spec.tool_name,
        behavior: payload.behavior,
        message: payload.message ?? null,
        updatedInput: payload.updatedInput ?? null,
      }) + "\n",
    );
  }
  if (payload.behavior === "deny" && payload.message === "request expired") {
    await mcpClient?.close().catch(() => {});
    process.exit(0);
  }
  return payload;
}

const required = [
  ["--input-format", "stream-json"],
  ["--output-format", "stream-json"],
];
const valid =
  args.includes("-p") &&
  args.includes("--verbose") &&
  args.includes("--include-partial-messages") &&
  required.every(([flag, value]) => valueAfter(flag) === value) &&
  (valueAfter("--session-id") !== undefined) !==
    (valueAfter("--resume") !== undefined);
if (!valid) {
  process.stderr.write("secant replayer: required stream-json flags missing\n");
  process.exit(2);
}

const protocolCase = JSON.parse(
  readFileSync(join(caseDirectory, "case.json"), "utf8"),
);

// A launch with `--resume` reattaches a detached Session: replay the case's
// separately recorded resumed process (its init may or may not acknowledge the
// Session, exactly as recorded). A first launch uses the initial recording.
const resuming = valueAfter("--resume") !== undefined;
const playback = resuming ? protocolCase.resume : protocolCase;
if (!playback) {
  process.stderr.write(
    "secant replayer: no recorded process for this launch\n",
  );
  process.exit(2);
}

// A case can model a process that ignores SIGTERM: swallow it so only SIGKILL
// (a group force-kill) stops the process, driving the Adapter's escalation path.
if (playback.ignoreSigterm) {
  process.removeAllListeners("SIGTERM");
  process.on("SIGTERM", () => {});
}

const write = (stream, bytes) =>
  new Promise((resolve, reject) => {
    stream.write(bytes, (error) => (error ? reject(error) : resolve()));
  });

let turnIndex = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.length === 0) continue;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.stderr.write("secant replayer: stdin was not JSON\n");
    process.exit(2);
  }
  if (frame.type !== "user" || frame.message?.role !== "user") {
    process.stderr.write("secant replayer: stdin was not a user Turn\n");
    process.exit(2);
  }
  if (recording.log) {
    appendFileSync(
      recording.log,
      JSON.stringify({ type: "stdin", id: invocationId, line }) + "\n",
    );
  }
  const turn = playback.turns[turnIndex++];
  if (!turn) {
    process.stderr.write(
      "secant replayer: received more Turns than recorded\n",
    );
    process.exit(2);
  }
  if (Array.isArray(turn.steps)) {
    // Ordered mix of stdout emissions and permission-bridge calls. A bridge step
    // blocks until Secant answers it, so the recorded stdout after it emits only
    // once the permission verdict is in — the "recorded point in the Turn".
    for (const step of turn.steps) {
      if (step.emit) {
        await write(
          process.stdout,
          readFileSync(join(caseDirectory, step.emit)),
        );
      } else if (step.bridge) {
        await bridgeCall(step.bridge);
      } else if (Array.isArray(step.bridgeAll)) {
        await Promise.all(step.bridgeAll.map(bridgeCall));
      }
    }
  } else {
    await write(process.stdout, readFileSync(join(caseDirectory, turn.stdout)));
    if (turn.stderr) {
      await write(
        process.stderr,
        readFileSync(join(caseDirectory, turn.stderr)),
      );
    }
  }
  // A Turn that models "process exits without a result" (a lost or corrupt case)
  // ends the process right after its bytes instead of awaiting more stdin.
  if (turn.exitAfter) process.exit(playback.exitCode ?? 0);
}

await mcpClient?.close().catch(() => {});
process.exitCode = playback.exitCode;
