import type {
  RendererKeyEvent,
  RendererPort,
} from "../../src/tui/renderer/renderer.js";

// The shared TUI screen-test fixtures (A52). The eight per-file fake Renderer
// Ports differed only in which of {inject a key, drive a resize} they wired up;
// this one parameterised fake carries the size and the key/resize subscribers so
// every screen test drives the same Port. `until` is the one bounded poll the
// screen tests share (four byte-identical copies before).

export interface FakeRenderer {
  readonly port: RendererPort;
  /** Deliver a key event to every current subscriber. */
  key(
    name: string,
    mods?: { ctrl?: boolean; shift?: boolean; sequence?: string },
  ): void;
  /** Change the reported size and notify every resize subscriber. */
  resize(width: number, height: number): void;
}

/** A fake Renderer Port that records its key and resize subscribers so a test can
 *  inject either. Size defaults keep the no-argument screen tests terse. */
export function makeFakeRenderer(width = 80, height = 24): FakeRenderer {
  let w = width;
  let h = height;
  const keys = new Set<(event: RendererKeyEvent) => void>();
  const resizes = new Set<(width: number, height: number) => void>();
  const port: RendererPort = {
    size: () => ({ width: w, height: h }),
    onKey: (fn) => {
      keys.add(fn);
      return () => keys.delete(fn);
    },
    onResize: (fn) => {
      resizes.add(fn);
      return () => resizes.delete(fn);
    },
    destroy() {},
    destroyed: false,
  };
  return {
    port,
    key: (name, mods = {}) => {
      for (const fn of keys) fn({ name, ...mods });
    },
    resize: (nw, nh) => {
      w = nw;
      h = nh;
      for (const fn of resizes) fn(nw, nh);
    },
  };
}

/** Poll `predicate` on a short interval until it holds or the budget elapses. */
export async function until(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition not met within the time budget.");
}
