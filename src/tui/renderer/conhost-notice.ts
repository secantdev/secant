import { dlopen } from "bun:ffi";

// The legacy-conhost startup notice (ADR 0030 "Legacy conhost"). On Windows,
// when Secant's shell is launched from a console window owned by legacy conhost,
// OpenTUI's teardown can wedge that window on exit (anomalyco/opentui#1405 — the
// stdin-release wedge the renderer teardown works around is exit-only, no Secant
// data is lost). Windows Terminal and ConPTY hosts are unaffected. This prints a
// notice pointing at Windows Terminal and waits for one keypress before the
// renderer takes the screen, so the notice can be read (#70); Ctrl+C at the wait
// exits without TUI takeover. The TUI still runs once a key is pressed.
//
// Detection and the keypress are behind injectable seams so every branch
// unit-tests on every OS without touching Windows APIs or real stdin. The
// production probe is the only `bun:ffi` importer in target source, allowlisted
// in tests/architecture/check-vendor-provenance.ts.
//
// ponytail: whole guard goes once Bun merges the stdin-release fix
// (https://github.com/oven-sh/bun/pull/35621) — delete this file, its call at
// the runTuiApp seam, its allowlist entry, and its test.

/** Reports whether the console window is a visible, conhost-owned window. */
export type ConsoleProbe = () => boolean;

/** Resolves once one key is read: `exit` for Ctrl+C (or closed input). */
export type WaitForKeypress = () => Promise<"continue" | "exit">;

/** The notice. Status is carried by words, never by colour. */
export const CONHOST_NOTICE =
  "Notice: this looks like a legacy console window. Exiting Secant here may " +
  "close the window and leave it unusable — Windows Terminal is the supported " +
  "console.\nPress any key to continue, or Ctrl+C to exit.\n";

/** The conventional SIGINT exit status, for Ctrl+C at the notice's wait. */
export const CONHOST_NOTICE_EXIT_CODE = 130;

export interface ConhostNoticeGate {
  readonly probe: ConsoleProbe;
  readonly isWindowsTerminalSession: boolean;
  readonly write: (text: string) => void;
  readonly waitForKeypress: WaitForKeypress;
}

/**
 * Runs `launch` behind the notice. The gate sits at one named seam in the TUI
 * launch path (`runTuiApp`), after the no-interactive-terminal rejection and
 * before anything is wired or the renderer is created. Windows Terminal is
 * checked first, so its launch never probes, prints, or waits.
 */
export async function runBehindConhostNotice(
  gate: ConhostNoticeGate,
  launch: () => Promise<number>,
): Promise<number> {
  if (!gate.isWindowsTerminalSession && gate.probe()) {
    gate.write(CONHOST_NOTICE);
    if ((await gate.waitForKeypress()) === "exit")
      return CONHOST_NOTICE_EXIT_CODE;
  }
  return launch();
}

/** The slice of `process.stdin` the keypress read touches. */
export interface KeypressInput {
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "end", listener: () => void): unknown;
}

/**
 * Reads one keypress in raw mode, so Ctrl+C arrives as the 0x03 byte rather
 * than a signal. Before resolving it hands stdin back paused, cooked, and
 * listener-free — OpenTUI takes stdin next, and a leftover listener or raw mode
 * is the same class of stdin leak as the anomalyco/opentui#1405 exit wedge.
 * Unlike the teardown release it never destroys stdin: the renderer needs it.
 */
export function createStdinKeypress(stdin: KeypressInput): WaitForKeypress {
  return () =>
    new Promise((resolve) => {
      const settle = (result: "continue" | "exit") => {
        stdin.off("data", onData);
        stdin.off("end", onEnd);
        stdin.setRawMode(false);
        stdin.pause();
        resolve(result);
      };
      const onData = (chunk: Buffer | string) =>
        settle(String(chunk).includes("\x03") ? "exit" : "continue");
      const onEnd = () => settle("exit");
      stdin.on("data", onData);
      stdin.on("end", onEnd);
      stdin.setRawMode(true);
      stdin.resume();
    });
}

/**
 * The production FFI probe, reached after the composition root has passed
 * Windows Terminal's inherited `WT_SESSION` marker to `runBehindConhostNotice`. A
 * real-terminal check found a visible console window in an ordinary Windows
 * Terminal tab, invalidating visibility as a sufficient discriminator. This
 * remains the fallback because microsoft/terminal#13006 says the marker can be
 * absent for default-host launches. Non-Windows and any FFI failure report
 * false — no notice.
 */
export const conhostConsoleProbe: ConsoleProbe = () => {
  if (process.platform !== "win32") return false;
  // ponytail: runs once at startup, so the two dlopen handles are left open for
  // the process lifetime (kernel32/user32 are system-pinned anyway). If this is
  // ever called more than once, close both handles.
  try {
    const kernel32 = dlopen("kernel32.dll", {
      GetConsoleWindow: { args: [], returns: "ptr" },
    });
    const user32 = dlopen("user32.dll", {
      IsWindowVisible: { args: ["ptr"], returns: "i32" },
    });
    const hwnd = kernel32.symbols.GetConsoleWindow();
    if (!hwnd) return false;
    return user32.symbols.IsWindowVisible(hwnd) !== 0;
  } catch {
    return false;
  }
};
