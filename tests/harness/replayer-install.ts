// Runtime-only installer for the recorded Claude Code replayer. It deliberately
// has no node:test dependency so package-smoke.ts can use the same fake from a
// plain Bun process; replayer.ts adds test-runner-owned temporary-directory cleanup.

import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join } from "node:path";

const replayerSource = join(
  dirname(fileURLToPath(import.meta.url)),
  "replayer.mjs",
);

const MCP_CLIENT_MODULE = import.meta
  .resolve("@modelcontextprotocol/sdk/client/index.js");
const MCP_TRANSPORT_MODULE = import.meta
  .resolve("@modelcontextprotocol/sdk/client/streamableHttp.js");

/** Read the replayer's newline-delimited JSON log (D13): the one reader both the
 *  invocation and bridge views parse. An empty log yields no entries. The entries
 *  stay `JSON.parse`-loose, as both call sites read them by hand. */
function readLogEntries(logPath: string) {
  const text = readFileSync(logPath, "utf8").trim();
  if (text.length === 0) return [];
  return text.split("\n").map((line) => JSON.parse(line));
}

export interface BridgeRecord {
  id: string;
  tool_name: string;
  behavior: string;
  message: string | null;
  updatedInput: unknown;
}

export interface InstalledReplayer {
  readonly dir: string;
  readonly path: string;
  readonly executablePath: string;
  readonly identityPath: string;
  readonly logPath: string;
  readonly version: string;
  invocations(): {
    args: string[];
    cwd: string;
    stdinBytes: number;
    stdinLines: string[];
  }[];
  bridges(): BridgeRecord[];
  drift(newVersion: string): void;
}

/** The npm `cmd-shim` shape the process Module parses on Windows. */
function npmBunShim(scriptRelative: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\bun.exe" (',
    '  SET "_prog=%dp0%\\bun.exe"',
    ") ELSE (",
    '  SET "_prog=bun"',
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${scriptRelative}" %*`,
  ].join("\r\n");
}

/** Install one PATH-discoverable `claude` replayer in an existing or new dir. */
export function installReplayerAt(
  dir: string,
  version: string,
  protocolCaseDirectory?: string,
): InstalledReplayer {
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "invocations.log");
  writeFileSync(logPath, "");

  const windows = process.platform === "win32";
  let executablePath: string;
  let identityPath: string;
  if (windows) {
    executablePath = join(dir, "claude.cmd");
    identityPath = join(dir, "claude.mjs");
    copyFileSync(replayerSource, identityPath);
    writeFileSync(executablePath, npmBunShim("claude.mjs"));
  } else {
    executablePath = join(dir, "claude");
    identityPath = executablePath;
    copyFileSync(replayerSource, executablePath);
    chmodSync(executablePath, 0o755);
  }

  let current = version;
  const writeRecording = () => {
    writeFileSync(
      join(dir, "recording.json"),
      JSON.stringify(
        {
          harness: "claude-code",
          executableVersion: current,
          version: current,
          log: logPath,
          protocolCaseDirectory,
          mcpClientModule: MCP_CLIENT_MODULE,
          mcpTransportModule: MCP_TRANSPORT_MODULE,
          recordedAt: "1970-01-01T00:00:00Z",
          redactions: [],
          refreshCommand:
            "n/a — synthesised by tests/harness/replayer-install.ts",
        },
        null,
        2,
      ),
    );
  };
  writeRecording();

  return {
    dir,
    path: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    executablePath,
    identityPath,
    logPath,
    get version() {
      return current;
    },
    invocations() {
      const entries = readLogEntries(logPath);
      const invocations = new Map<
        string,
        {
          args: string[];
          cwd: string;
          stdinBytes: number;
          stdinLines: string[];
        }
      >();
      for (const entry of entries) {
        if (entry.type === "start") {
          invocations.set(entry.id, {
            args: entry.args,
            cwd: entry.cwd,
            stdinBytes: 0,
            stdinLines: [],
          });
          continue;
        }
        if (entry.type !== "stdin") continue;
        const invocation = invocations.get(entry.id);
        if (!invocation) continue;
        invocation.stdinLines.push(entry.line);
        invocation.stdinBytes += Buffer.byteLength(`${entry.line}\n`);
      }
      return [...invocations.values()];
    },
    bridges() {
      return readLogEntries(logPath)
        .filter((entry) => entry.type === "bridge")
        .map((entry) => ({
          id: entry.id,
          tool_name: entry.tool_name,
          behavior: entry.behavior,
          message: entry.message,
          updatedInput: entry.updatedInput ?? null,
        }));
    },
    drift(newVersion: string) {
      current = newVersion;
      appendFileSync(identityPath, `\n// drift ${newVersion} ${Date.now()}\n`);
      writeRecording();
    },
  };
}
