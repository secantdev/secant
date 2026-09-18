// Test-runner wrapper around the runtime-only Codex replayer installer. Tests
// receive a unique temporary directory that tests/helpers/tempDir.ts reclaims
// after the run; package-smoke imports codex-replayer-install.ts directly and
// owns its directory.

import { installCodexReplayerAt } from "./codex-replayer-install.js";
import { makeTempDir } from "../helpers/tempDir.js";

export type {
  CodexApprovalReplay,
  CodexInvocation,
  CodexRecoveryReplayOptions,
  CodexTurnReplayOptions,
  InstalledCodexReplayer,
} from "./codex-replayer-install.js";

export function installCodexReplayer(
  caseName: string,
  syntheticFaultInjection = false,
) {
  return installCodexReplayerAt(
    makeTempDir("secant-codex-replayer-"),
    caseName,
    syntheticFaultInjection,
  );
}

/** Protocol-private deterministic fault injection. Real recorded cases must use
 * `installCodexReplayer(caseName)` and therefore strict playback. */
export function installSyntheticCodexReplayer() {
  return installCodexReplayer("codex-qualification", true);
}
