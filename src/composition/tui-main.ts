// The public shell launch. Kept as a thin seam so the CLI reaches the renderer
// only through a dynamic import: the headless paths never load Solid or
// OpenTUI's native library. The shell runs in-process under the compiled Bun
// binary — the renderer's flags (formerly a Node re-exec for `--experimental-ffi`
// and `--conditions=browser`) are no longer needed.

/** Launches the interactive shell. */
export async function launchTui(): Promise<number> {
  const { runTuiApp } = await import("./tui-runtime.js");
  return runTuiApp();
}
