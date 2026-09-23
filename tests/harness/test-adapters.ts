// Test-only construction of the native Harness Adapters. The production factories
// (`src/harness/harness.ts`) require the Process Interface as an explicit argument
// — composition injects the one real instance it constructs (#202). Tests almost
// always want the real Process implementation, so this helper supplies it by
// default while still letting a suite inject a scripted Process double (e.g.
// `processWithSpawn`). Keeping the default here, rather than in the shipped
// factory, keeps the production interface honest: it never constructs a hidden
// dependency of its own.

import {
  createClaudeCodeAdapter as createClaudeCodeAdapterWithProcess,
  createCodexAdapter as createCodexAdapterWithProcess,
  type HarnessAdapter,
} from "../../src/harness/harness.js";
import {
  createProcessAdapter,
  type ProcessAdapter,
} from "../../src/process/process.js";

type ClaudeCodeOverrides = Parameters<
  typeof createClaudeCodeAdapterWithProcess
>[0];
type CodexOverrides = Parameters<typeof createCodexAdapterWithProcess>[0];

export function createClaudeCodeAdapter(
  overrides: ClaudeCodeOverrides = {},
  processAdapter: ProcessAdapter = createProcessAdapter(),
): HarnessAdapter {
  return createClaudeCodeAdapterWithProcess(overrides, processAdapter);
}

export function createCodexAdapter(
  overrides: CodexOverrides = {},
  processAdapter: ProcessAdapter = createProcessAdapter(),
): HarnessAdapter {
  return createCodexAdapterWithProcess(overrides, processAdapter);
}
