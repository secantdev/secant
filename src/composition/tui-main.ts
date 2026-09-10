import { spawnSync } from "node:child_process";

// The public shell launch. It stays light on purpose: it must re-exec BEFORE
// anything imports Solid or the renderer, because both the reactive `solid-js`
// build (`--conditions=browser`) and OpenTUI's native FFI (`--experimental-ffi`)
// are fixed at process start. The real runtime work — including the
// interactive-terminal gate — lives behind a dynamic import that only runs in
// the re-exec'd child, so a launch always loads OpenTUI (proving the installed
// package's ESM entry points resolve) before deciding it has no terminal.

// Set on the re-exec'd child so we launch the renderer at most once.
const ACTIVE = "SECANT_TUI_ACTIVE";

/** Launches the interactive shell. */
export async function launchTui(argv: readonly string[]): Promise<number> {
  if (process.env[ACTIVE] !== "1") {
    // ponytail: re-exec to set the two start-of-process Node flags the shell
    // needs. Simplest portable delivery for an installed bin; a shebang cannot
    // pass flags. Add NODE_OPTIONS plumbing only if a host forbids re-exec.
    const entry = process.argv[1];
    if (entry === undefined)
      throw new Error("Cannot re-exec: no entry script.");
    // Forward the parent's own Node flags (e.g. tsx's loader under `npm run
    // dev`) so the child can still resolve the source, then add the two the
    // shell needs.
    const result = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        "--experimental-ffi",
        "--conditions=browser",
        entry,
        ...argv,
      ],
      { stdio: "inherit", env: { ...process.env, [ACTIVE]: "1" } },
    );
    if (result.error) throw result.error;
    return result.status ?? 1;
  }

  const { runTuiApp } = await import("./tui-runtime.js");
  return runTuiApp();
}
