import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CODEX_RECORDING_INPUT = {
  completion: "Reply with exactly: recorded completion.",
  secondCompletion: "Reply with exactly: recorded second completion.",
  approval:
    "Run `touch /tmp/secant-codex-recording-approval` now. Do not do anything else.",
  steer:
    "Think silently about the number one until you receive more guidance. Do not inspect files or run tools.",
  steerGuidance: "Finish now with exactly: recorded steer.",
  sleep: "Run `sleep 30` now. Do not inspect files or do anything else.",
  resume: "Reply with exactly: recorded resume.",
} as const;

export function codexTestRepairPrompt(workspace: string): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "bundles",
      "test-repair-workflow",
      "prompts",
      "fix.md",
    ),
    "utf8",
  ).replace("{{artifact:failing-test}}", join(workspace, "sum.test.mjs"));
}
