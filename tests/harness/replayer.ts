// Installs the `claude` replayer (replayer.mjs) onto a temporary directory so
// the Claude Code Adapter discovers and spawns it for real (#111). On POSIX the
// replayer is copied to `claude` and made executable through its shebang; on
// Windows it is an npm-style `.cmd` shim naming the Bun runtime plus a colocated
// `claude.mjs`, exactly the shape the process Module's shim resolver parses, so
// the shim resolves to the runtime and script and is spawned directly.

import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join } from "node:path";
import { makeTempDir } from "../helpers/tempDir.js";

const replayerSource = join(
  dirname(fileURLToPath(import.meta.url)),
  "replayer.mjs",
);

export interface InstalledReplayer {
  /** The directory the replayer lives in. */
  readonly dir: string;
  /** A PATH value that resolves the replayer's `claude` first, then falls back
   *  to the real PATH — so the Windows `.cmd` shim's runtime interpreter (`bun`,
   *  which lives on the real PATH, never in this temp dir) still resolves. Pass
   *  this as the Adapter's `path` override for a real spawn. */
  readonly path: string;
  /** The absolute path of the `claude` entry (`claude` on POSIX, `claude.cmd`
   *  on Windows) — an explicit configured executable for discovery tests. */
  readonly executablePath: string;
  /** The path whose bytes identify this install; rewriting it drifts the file
   *  identity so the Adapter requalifies. */
  readonly identityPath: string;
  /** The log every invocation appends to (argv + stdin byte count). */
  readonly logPath: string;
  /** The version string the replayer answers `--version` with. */
  readonly version: string;
  /** How many times the replayer has been spawned. */
  invocations(): { args: string[]; stdinBytes: number }[];
  /** Drift the install: change the identity file's bytes and the reported
   *  version, so the next `prepare` requalifies instead of reusing the cache. */
  drift(newVersion: string): void;
}

/** The npm `cmd-shim` shape the process Module parses: `_prog` is the runtime
 *  (a colocated `bun.exe`, else the bare `bun` on PATH) invoked on a
 *  `%dp0%`-relative script. */
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

export function installReplayer(version: string): InstalledReplayer {
  const dir = makeTempDir("secant-claude-replayer-");
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
    // Only `version` and `log` are read by the replayer; the metadata fields are
    // the recording.json shape testing.md fixes, kept here for provenance even
    // though a runtime temp install is not a committed fixture.
    writeFileSync(
      join(dir, "recording.json"),
      JSON.stringify(
        {
          harness: "claude-code",
          executableVersion: current,
          version: current,
          log: logPath,
          recordedAt: "1970-01-01T00:00:00Z",
          redactions: [],
          refreshCommand: "n/a — synthesised by tests/harness/replayer.ts",
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
      const text = readFileSync(logPath, "utf8").trim();
      if (text.length === 0) return [];
      return text.split("\n").map((line) => JSON.parse(line));
    },
    drift(newVersion: string) {
      current = newVersion;
      // Changing the identity file's bytes drifts size (and mtime), so the
      // Adapter's cache key no longer matches and it requalifies.
      appendFileSync(identityPath, `\n// drift ${newVersion} ${Date.now()}\n`);
      writeRecording();
    },
  };
}
