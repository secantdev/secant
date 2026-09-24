import {
  CliRenderEvents,
  createCliRenderer,
  type CliRenderer,
} from "@opentui/core";

// The legacy-conhost startup notice is a renderer-module terminal concern (it
// complements the stdin-release teardown wedge below); re-exported here so the
// composition launch path reaches it through the module entrypoint.
export {
  CONHOST_NOTICE,
  CONHOST_NOTICE_EXIT_CODE,
  conhostConsoleProbe,
  createStdinKeypress,
  runBehindConhostNotice,
  type ConhostNoticeGate,
  type ConsoleProbe,
  type KeypressInput,
  type WaitForKeypress,
} from "./conhost-notice.js";

// The Renderer Port is narrowed to lifecycle only (ADR 0018): size, onKey,
// onResize, destroy, destroyed. Drawing and input reach view components through
// OpenTUI's Solid integration directly, never through this Port. The Port earns
// its keep by making teardown ordering exercisable against a fake with no
// terminal and no native library.

/** The narrow key value the Port hands its one consumer (the Run Workbench). It
 *  declares only the two fields that drive the Workbench's raw-key pipeline, so no
 *  OpenTUI key type crosses the Port and the consumer needs no cast (A16). The
 *  production Adapter's richer key event (OpenTUI's `ParsedKey`) is assignable to
 *  it; the fields are optional because a Port consumer must not assume more. */
export interface RendererKeyEvent {
  readonly name?: string;
  readonly ctrl?: boolean;
}

export interface RendererPort {
  /** Current terminal cell dimensions. */
  size(): { readonly width: number; readonly height: number };
  /** Subscribe to raw key events; returns an unsubscribe. */
  onKey(handler: (event: RendererKeyEvent) => void): () => void;
  /** Subscribe to resize events; returns an unsubscribe. */
  onResize(handler: (width: number, height: number) => void): () => void;
  /** Release the terminal. Idempotent. */
  destroy(): void;
  readonly destroyed: boolean;
}

/**
 * The stdin handle the teardown releases before destroying the renderer. Its
 * concrete production form drains `process.stdin`; tests inject a recorder.
 */
export interface StdinRelease {
  release(): void;
}

/**
 * The one lifecycle invariant OpenTUI's defect forces on us (ADR 0018): release
 * `process.stdin` fully BEFORE `renderer.destroy()`, or legacy conhost wedges on
 * the next loop turn — see https://github.com/anomalyco/opentui/issues/1405. The
 * returned teardown runs exactly once no matter how many exit paths call it, and
 * `onTeardown` runs on that one admitted call — the guard is the single source of
 * truth for "this call did the work", so callers never re-derive it from a side
 * effect of `port.destroy()`.
 */
export function createTeardown(
  stdin: StdinRelease,
  port: RendererPort,
  onTeardown?: () => void,
): () => void {
  let torndown = false;
  return () => {
    if (torndown) return;
    torndown = true;
    // Order is load-bearing: stdin first, renderer second. Do not tidy this
    // swap away — see anomalyco/opentui#1405.
    stdin.release();
    port.destroy();
    onTeardown?.();
  };
}

/** Drains the real `process.stdin` so no handle survives on the event loop. */
export function createProcessStdinRelease(): StdinRelease {
  return {
    release() {
      const stdin = process.stdin;
      stdin.removeAllListeners("data");
      stdin.removeAllListeners("readable");
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdin.unref();
      stdin.destroy();
    },
  };
}

function wrapRenderer(renderer: CliRenderer): RendererPort {
  return {
    size: () => ({ width: renderer.width, height: renderer.height }),
    onKey(handler) {
      renderer.keyInput.on("keypress", handler);
      return () => renderer.keyInput.off("keypress", handler);
    },
    onResize(handler) {
      const listener = (width: number, height: number) =>
        handler(width, height);
      renderer.on(CliRenderEvents.RESIZE, listener);
      return () => renderer.off(CliRenderEvents.RESIZE, listener);
    },
    destroy() {
      renderer.setTerminalTitle("");
      if (renderer.isDestroyed) return;
      renderer.destroy();
    },
    get destroyed() {
      return renderer.isDestroyed;
    },
  };
}

/**
 * The production Adapter over OpenTUI's `createCliRenderer` at the owned pin.
 * Returns the raw renderer too, because Solid's `render(node, renderer)` mounts
 * onto it directly while the Port owns its lifecycle. Requires an interactive
 * terminal and the native FFI runtime; callers gate both first.
 */
export async function createProductionRenderer(): Promise<{
  port: RendererPort;
  renderer: CliRenderer;
}> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, // we own Ctrl+C: it dismisses a dialog or nothing
    // Own every exit path in the composition root. OpenTUI's default
    // `exitSignals` register a handler that calls `renderer.destroy()` directly
    // on SIGINT/SIGTERM/SIGHUP — which would destroy the renderer BEFORE the
    // stdin release and reintroduce the conhost wedge (anomalyco/opentui#1405)
    // the teardown invariant exists to prevent. An empty list registers none.
    exitSignals: [],
    targetFps: 60,
    gatherStats: false,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
  });
  return { port: wrapRenderer(renderer), renderer };
}

/** A fake Adapter with no terminal and no native library, for teardown tests. */
export function createFakeRenderer(): RendererPort {
  let destroyed = false;
  return {
    size: () => ({ width: 80, height: 24 }),
    onKey: () => () => {},
    onResize: () => () => {},
    destroy() {
      destroyed = true;
    },
    get destroyed() {
      return destroyed;
    },
  };
}
