import { dlopen } from "bun:ffi";

// The legacy-conhost startup notice (ADR 0030 "Legacy conhost"). On Windows,
// when Secant's shell is launched from a console window owned by legacy conhost,
// OpenTUI's teardown can wedge that window on exit (anomalyco/opentui#1405 — the
// stdin-release wedge the renderer teardown works around is exit-only, no Secant
// data is lost). Windows Terminal and ConPTY hosts are unaffected. This prints a
// one-line notice pointing at Windows Terminal; the TUI then runs as normal.
//
// Detection is behind an injectable probe so both branches unit-test on every OS
// without touching Windows APIs. The production probe is the only `bun:ffi`
// importer in target source, allowlisted in
// tests/architecture/check-vendor-provenance.ts.
//
// ponytail: whole guard goes once Bun merges the stdin-release fix
// (https://github.com/oven-sh/bun/pull/35621) — delete this file, its call at
// the runTuiApp seam, its allowlist entry, and its test.

/** Reports whether the console window is a visible, conhost-owned window. */
export type ConsoleProbe = () => boolean;

/** The one-line notice. Status is carried by words, never by colour. */
export const CONHOST_NOTICE =
  "Notice: this looks like a legacy console window. Exiting Secant here may " +
  "close the window and leave it unusable — Windows Terminal is the supported " +
  "console.\n";

/**
 * Prints the notice when the probe reports a visible conhost window. The guard
 * sits at one named seam in the TUI launch path (`runTuiApp`), after the
 * no-interactive-terminal rejection and before the renderer is created.
 */
export function printConhostNotice(
  probe: ConsoleProbe,
  out: (text: string) => void,
): void {
  if (probe()) out(CONHOST_NOTICE);
}

/**
 * The production probe: `GetConsoleWindow` + `IsWindowVisible` over `bun:ffi`.
 * A legacy conhost window is visible; ConPTY's headless conhost (used by Windows
 * Terminal and every pseudo-console) has an invisible window, so it reports
 * false. Non-Windows and any failure report false — no notice.
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
