import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import which from "which";

// The process Module owns the "owned child process" mechanics that a Command step
// and a Harness both need: it resolves a Command's authored executable to
// something spawnable directly (never through a shell), spawns it with piped
// stdio, leads it into its own process group off Windows, and reaps the whole tree
// on a timeout or cancel — SIGTERM→SIGKILL on POSIX, `taskkill /T /F` on Windows.
//
// It imports nothing from other Modules and reaches the OS only through
// `node:child_process` and the single `which` PATH walk (no new Bun API, ADR 0030).
// Run execution, Application (Preflight), and the Harness Module are its callers,
// so their precondition checks and their spawns agree by construction (A40, D1).

// --- Executable resolution --------------------------------------------------

/**
 * How a Command's authored executable resolves on this host to something spawnable
 * directly, never through a shell (#21). This is the one executable resolver this
 * Module owns and exports; Preflight consumes it so its precondition check and this
 * Module's spawn agree by construction (A40, D1).
 *
 * - `found`: spawn `executable` with `prefixArgs` ahead of the Command's own
 *   arguments. A native binary resolves to itself with no prefix. An npm-style
 *   Windows `.cmd` shim resolves to its real target — `node` plus the script the
 *   shim wraps — so it runs without `cmd.exe` (cross-spawn is rejected precisely
 *   because it routes `.cmd` through `cmd.exe`).
 * - `not-found`: nothing on PATH satisfies the name, or a shim's own interpreter is
 *   unresolvable.
 * - `unsupported-shim`: a Windows `.cmd`/`.bat` that is not an npm-style node shim;
 *   Preflight refuses it and asks the author to name the interpreter.
 */
export type ExecutableResolution =
  | {
      readonly kind: "found";
      readonly executable: string;
      readonly prefixArgs: readonly string[];
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "unsupported-shim"; readonly path: string };

/** The PATH walk and the host platform are the two external facts resolution
 *  depends on; both are injectable adapters (testing.md) so the Windows shim path
 *  is exercised on any OS. Production passes neither. */
export interface ResolveExecutableOptions {
  /** Override PATH the walk searches (the real `which` still decides the match). */
  readonly path?: string;
  /** Override the host platform that gates the `.cmd`/`.bat` shim rule. */
  readonly platform?: NodeJS.Platform;
  /** Replace the PATH walk entirely, so the shim rule is testable without PATHEXT. */
  readonly resolve?: (name: string) => string | undefined;
}

/** The single PATH walk in `src/` (D1): `which` resolves the name to an absolute
 *  path, checking the executable bit (POSIX) and PATHEXT (Windows), so a
 *  non-executable file earlier on PATH never satisfies resolution. */
function walkPath(
  name: string,
  options: ResolveExecutableOptions,
): string | undefined {
  if (options.resolve !== undefined) return options.resolve(name);
  const result = which.sync(name, {
    nothrow: true,
    ...(options.path !== undefined ? { path: options.path } : {}),
  });
  return typeof result === "string" ? result : undefined;
}

export function resolveExecutable(
  name: string,
  options: ResolveExecutableOptions = {},
): ExecutableResolution {
  const resolved = walkPath(name, options);
  if (resolved === undefined) return { kind: "not-found" };
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const ext = extname(resolved).toLowerCase();
    if (ext === ".cmd" || ext === ".bat") {
      return resolveWindowsShim(resolved, options);
    }
  }
  return { kind: "found", executable: resolved, prefixArgs: [] };
}

/** Resolve a Windows `.cmd`/`.bat` to its real target. An npm-style node shim
 *  (`cmd-shim`) is resolved to `node` plus the script it wraps and spawned
 *  directly; anything else is `unsupported-shim` (Preflight refuses it). */
function resolveWindowsShim(
  shimPath: string,
  options: ResolveExecutableOptions,
): ExecutableResolution {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return { kind: "unsupported-shim", path: shimPath };
  }
  const target = parseNpmCmdShim(text, dirname(shimPath));
  if (target === undefined) return { kind: "unsupported-shim", path: shimPath };
  // The shim's own interpreter must itself resolve on PATH, or the real target
  // cannot run — that is a not-found, not an unsupported shim.
  const interpreter = walkPath(target.interpreter, options);
  if (interpreter === undefined) return { kind: "not-found" };
  return {
    kind: "found",
    executable: interpreter,
    prefixArgs: [target.script],
  };
}

/** Parse an npm `cmd-shim` `.cmd`: it sets `_prog` to its interpreter (a colocated
 *  binary in the `IF EXIST` branch, else the bare name on PATH in the `ELSE`
 *  branch) and invokes it on a `%dp0%`-relative script. Returns the bare
 *  interpreter name to resolve on PATH and the absolute script path, or undefined
 *  for any `.cmd`/`.bat` that is not this npm-style interpreter-plus-script shape. */
function parseNpmCmdShim(
  text: string,
  shimDir: string,
): { interpreter: string; script: string } | undefined {
  // The program-invocation line runs `"%_prog%" "<script>" %*`.
  const invocation = text
    .split(/\r?\n/)
    .find((line) => line.includes("%_prog%"));
  if (invocation === undefined) return undefined;
  const quoted = [...invocation.matchAll(/"([^"]*)"/g)].map(
    (match) => match[1]!,
  );
  const scriptToken = quoted.find(
    (token) => /%dp0%/i.test(token) && /\.[cm]?js$/i.test(token),
  );
  if (scriptToken === undefined) return undefined;
  // The interpreter is the `_prog` value that is a bare PATH name — the `ELSE`
  // branch — not the `%dp0%`-relative colocated one. Its absence means this is not
  // an npm-style shim, so it is refused rather than run through a shell.
  const interpreter = [...text.matchAll(/SET\s+"?_prog=([^"\r\n]+)"?/gi)]
    .map((match) => match[1]!.replace(/"$/, "").trim())
    .find((value) => value.length > 0 && !/%dp0%/i.test(value));
  if (interpreter === undefined) return undefined;
  return { interpreter, script: expandDp0(scriptToken, shimDir) };
}

/** Expand a `%dp0%`-relative shim token to an absolute path under the shim's
 *  directory, joining on either separator so the result is a host-native path. */
function expandDp0(token: string, shimDir: string): string {
  const relative = token.replace(/^%dp0%/i, "");
  const segments = relative.split(/[\\/]+/).filter((segment) => segment.length);
  return join(shimDir, ...segments);
}

// --- Direct spawn with tree reaping -----------------------------------------

/** What became of one spawned Command. `timeout` and `cancelled` are our own
 *  aborts (we killed the group); `signal` is a death by an outside signal we did
 *  not cause; `spawn-error` is a child that never ran. */
export type SpawnResult =
  | {
      readonly kind: "exited";
      readonly status: number;
      readonly text: Uint8Array;
    }
  | { readonly kind: "spawn-error" }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "signal" };

export interface SpawnOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** The caller's streaming byte cap on captured output: past it, chunks are
   *  dropped (the counter keeps running) and `truncationMarker` is appended, so a
   *  runaway Command cannot exhaust memory (D3). The cap is the caller's policy;
   *  this Module only enforces the value it is given. */
  readonly maxCaptureBytes: number;
  readonly truncationMarker: string;
  readonly cancelSignal?: AbortSignal;
}

// After an abort (timeout or cancel) the group gets SIGTERM, then SIGKILL if a
// child is still alive this long later — long enough for a well-behaved child to
// flush and exit, short enough to bound a hang (D2, #21).
const KILL_ESCALATION_MS = 3000;

/**
 * Spawn a resolved Command target directly (never a shell), stream its output
 * under a byte cap, and settle to a typed SpawnResult. On POSIX the child is
 * detached so it leads its own process group; a timeout or cancel aborts, and the
 * whole group is killed — `kill(-pid, SIGTERM)` on POSIX, `taskkill /T /F` on
 * Windows — escalating to SIGKILL after a grace period so a grandchild holding
 * stdout open cannot outlive its parent (D2, #21). stdin is closed so a command
 * that reads it gets EOF rather than hanging.
 */
export function spawnCommand(options: SpawnOptions): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const abort =
      options.cancelSignal !== undefined
        ? AbortSignal.any([timeoutSignal, options.cancelSignal])
        : timeoutSignal;

    const child = spawn(options.executable, [...options.args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // A detached POSIX child leads its own process group, so `kill(-pid, ...)`
      // reaches every descendant. Windows has no process groups; taskkill /T walks
      // the tree instead, so detaching there would only orphan the child.
      detached: process.platform !== "win32",
    });

    // Stream stdout then stderr under a shared cap: past it, chunks are dropped and
    // a marker is appended (D3). Buffers preserve the "stdout first" ordering the
    // synchronous path had, without holding unbounded output in memory.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    const collect = (into: Buffer[], chunk: Buffer): void => {
      const remaining = options.maxCaptureBytes - captured;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > remaining) {
        into.push(chunk.subarray(0, remaining));
        captured = options.maxCaptureBytes;
        truncated = true;
      } else {
        into.push(chunk);
        captured += chunk.length;
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderrChunks, chunk));

    let escalation: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      killGroup(child, "SIGTERM");
      escalation = setTimeout(
        () => killGroup(child, "SIGKILL"),
        KILL_ESCALATION_MS,
      );
      escalation.unref?.();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      if (escalation !== undefined) clearTimeout(escalation);
      abort.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.on("error", () => finish({ kind: "spawn-error" }));
    // `close` fires after the process exited and its stdio streams closed, so all
    // captured output is in hand — and, with the group killed, only once a
    // grandchild holding stdout open has died too.
    child.on("close", (code) => {
      // Attribute the exit. On POSIX our kill delivers a signal (a null exit code),
      // so a real exit code proves the child exited on its own — trust it even if an
      // abort fired in the same tick, closing the natural-exit-vs-timeout race there.
      // On Windows `taskkill /F` yields exit code 1, so a killed child has a non-null
      // code; there the abort flag is the only signal that we killed it.
      const killedByUs = process.platform === "win32" || code === null;
      if (killedByUs && options.cancelSignal?.aborted) {
        return finish({ kind: "cancelled" });
      }
      if (killedByUs && timeoutSignal.aborted)
        return finish({ kind: "timeout" });
      if (code === null) return finish({ kind: "signal" });
      let text = Buffer.concat([...stdoutChunks, ...stderrChunks]);
      if (truncated) {
        text = Buffer.concat([text, Buffer.from(options.truncationMarker)]);
      }
      finish({ kind: "exited", status: code, text });
    });
  });
}

/** Kill a spawned child and everything under it. On POSIX the negative pid targets
 *  the whole process group (the child was detached to lead one); on Windows
 *  `taskkill /T /F` walks the process tree. A not-found error means the child had
 *  already exited between the liveness check and the kill — swallow it (D2). */
function killGroup(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // taskkill /F already force-terminates the tree, so the SIGKILL escalation is a
    // harmless retry rather than a stronger signal.
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    // taskkill.exe may be unspawnable (stripped image, restrictive sandbox); an
    // unhandled 'error' event would crash the whole process, so swallow it — a
    // failed kill leaves the child to its own timeout, never a fault here.
    killer.on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
