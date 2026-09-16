// Test-runner wrapper around the runtime-only replayer installer. Tests receive a
// unique temporary directory that tests/helpers/tempDir.ts reclaims after the run;
// package smoke imports replayer-install.ts directly and owns its directory.

import { installReplayerAt } from "./replayer-install.js";
import { makeTempDir } from "../helpers/tempDir.js";

export type { BridgeRecord, InstalledReplayer } from "./replayer-install.js";

export function installReplayer(
  version: string,
  protocolCaseDirectory?: string,
) {
  return installReplayerAt(
    makeTempDir("secant-claude-replayer-"),
    version,
    protocolCaseDirectory,
  );
}
