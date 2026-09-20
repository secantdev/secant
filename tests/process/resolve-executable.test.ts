import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { resolveExecutable } from "../../src/process/process.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The one executable resolver the process Module owns and Preflight shares (D1,
// A40). Its primary PATH walk is `which`, so the executable bit decides
// resolution on POSIX; the Windows fallback and `.cmd`-shim paths are driven
// cross-OS through the injected resolver/platform seams. The package smoke owns
// the real Windows App Execution Alias acceptance path.

// The npm `cmd-shim` shape: `_prog` is node (a colocated node.exe, else the node
// on PATH), invoked on a `%dp0%`-relative script.
function npmNodeShim(scriptRelative: string): string {
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
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${scriptRelative}" %*`,
  ].join("\r\n");
}

test(
  "an executable earlier on PATH resolves; a non-executable file does not (POSIX)",
  { skip: process.platform === "win32" },
  () => {
    const nonExecDir = makeTempDir("secant-resolve-noexec-");
    const execDir = makeTempDir("secant-resolve-exec-");
    // A non-executable file named `mytool` earlier on PATH must not satisfy the
    // resolver; only the executable one later does (AC: the executable bit decides).
    writeFileSync(join(nonExecDir, "mytool"), "#!/bin/sh\necho hi\n");
    chmodSync(join(nonExecDir, "mytool"), 0o644);
    const execPath = join(execDir, "mytool");
    writeFileSync(execPath, "#!/bin/sh\necho hi\n");
    chmodSync(execPath, 0o755);

    // Only the non-executable one on PATH: nothing resolves.
    assert.deepEqual(resolveExecutable("mytool", { path: nonExecDir }), {
      kind: "not-found",
    });

    // The executable one, later on PATH, resolves to its absolute path directly.
    const resolution = resolveExecutable("mytool", {
      path: `${nonExecDir}${delimiter}${execDir}`,
    });
    assert.deepEqual(resolution, {
      kind: "found",
      executable: execPath,
      prefixArgs: [],
    });
  },
);

test("a name that resolves to no path is not-found", () => {
  assert.deepEqual(
    resolveExecutable("whatever", { resolve: () => undefined }),
    { kind: "not-found" },
  );
});

test("on Windows a missing PATH result falls back to the first where.exe match", () => {
  const probes: string[] = [];
  const aliasPath = String.raw`C:\Users\user\AppData\Local\Microsoft\WindowsApps\pwsh.exe`;
  const laterMatch = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`;

  const resolution = resolveExecutable("pwsh", {
    platform: "win32",
    resolve: (name) => {
      probes.push(`path:${name}`);
      return undefined;
    },
    resolveWindowsFallback: (name) => {
      probes.push(`windows-fallback:${name}`);
      return `${aliasPath}\r\n${laterMatch}\r\n`;
    },
  });

  assert.deepEqual(probes, ["path:pwsh", "windows-fallback:pwsh"]);
  assert.deepEqual(resolution, {
    kind: "found",
    executable: aliasPath,
    prefixArgs: [],
  });
});

test("a Windows fallback .cmd result still goes through the shim rule", () => {
  const shimDir = makeTempDir("secant-resolve-fallback-shim-");
  const shimPath = join(shimDir, "worker.cmd");
  writeFileSync(shimPath, npmNodeShim("worker.js"));
  const fakeNode = join(shimDir, "node.exe");
  writeFileSync(fakeNode, "");

  const resolution = resolveExecutable("worker", {
    platform: "win32",
    resolve: (name) => {
      if (name === "node") return fakeNode;
      return undefined;
    },
    resolveWindowsFallback: (name) =>
      name === "worker" ? shimPath : undefined,
  });

  assert.deepEqual(resolution, {
    kind: "found",
    executable: fakeNode,
    prefixArgs: [join(shimDir, "worker.js")],
  });
});

test("an empty Windows fallback remains not-found", () => {
  const probes: string[] = [];

  const resolution = resolveExecutable("missing", {
    platform: "win32",
    resolve: (name) => {
      probes.push(`path:${name}`);
      return undefined;
    },
    resolveWindowsFallback: (name) => {
      probes.push(`windows-fallback:${name}`);
      return " \r\n";
    },
  });

  assert.deepEqual(probes, ["path:missing", "windows-fallback:missing"]);
  assert.deepEqual(resolution, { kind: "not-found" });
});

test("POSIX does not consult the Windows fallback after a PATH miss", () => {
  const probes: string[] = [];

  const resolution = resolveExecutable("missing", {
    platform: "linux",
    resolve: (name) => {
      probes.push(`path:${name}`);
      return undefined;
    },
    resolveWindowsFallback: (name) => {
      probes.push(`windows-fallback:${name}`);
      return "/unexpected";
    },
  });

  assert.deepEqual(probes, ["path:missing"]);
  assert.deepEqual(resolution, { kind: "not-found" });
});

test("an npm-style .cmd shim resolves to node plus the wrapped script", () => {
  const shimDir = makeTempDir("secant-resolve-shim-");
  const shimPath = join(shimDir, "worker.cmd");
  writeFileSync(shimPath, npmNodeShim("worker.js"));
  const fakeNode = join(shimDir, "node.exe");
  writeFileSync(fakeNode, "");

  const resolution = resolveExecutable("worker", {
    platform: "win32",
    resolve: (name) =>
      name === "worker" ? shimPath : name === "node" ? fakeNode : undefined,
  });
  assert.deepEqual(resolution, {
    kind: "found",
    executable: fakeNode,
    prefixArgs: [join(shimDir, "worker.js")],
  });
});

test("an npm-style .cmd shim whose node interpreter is unresolvable is not-found", () => {
  const shimDir = makeTempDir("secant-resolve-shim-nonode-");
  const shimPath = join(shimDir, "worker.cmd");
  writeFileSync(shimPath, npmNodeShim("worker.js"));

  const resolution = resolveExecutable("worker", {
    platform: "win32",
    resolve: (name) => (name === "worker" ? shimPath : undefined),
  });
  assert.deepEqual(resolution, { kind: "not-found" });
});

test("a plain .bat that is not an npm node shim is refused as an unsupported shim", () => {
  const shimDir = makeTempDir("secant-resolve-bat-");
  const batPath = join(shimDir, "tool.bat");
  writeFileSync(batPath, "@echo off\r\necho not a node shim\r\n");

  const resolution = resolveExecutable("tool", {
    platform: "win32",
    resolve: (name) => (name === "tool" ? batPath : undefined),
  });
  assert.deepEqual(resolution, { kind: "unsupported-shim", path: batPath });
});

test("on POSIX a resolved path is spawned directly with no shim handling", () => {
  const dir = makeTempDir("secant-resolve-posix-");
  const toolPath = join(dir, "tool.cmd"); // extension is irrelevant off Windows
  writeFileSync(toolPath, "irrelevant");

  const resolution = resolveExecutable("tool", {
    platform: "linux",
    resolve: (name) => (name === "tool" ? toolPath : undefined),
  });
  assert.deepEqual(resolution, {
    kind: "found",
    executable: toolPath,
    prefixArgs: [],
  });
});
