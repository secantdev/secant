// The closed vocabulary the Harness Interface fixes. These sets are the contract
// every Adapter and every caller is written against; pinning them here fails
// loudly if a variant is added or dropped without a decision. Adding a variant is
// caught at compile time too: each array is built through `exhaustive<Union>()`,
// which fails the build when a new union member is not listed (A39) — this runtime
// pin then fixes the exact members and their order.

import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_DECISIONS,
  CLAUDE_CODE_SERVED_CAPABILITIES,
  CONTROL_REJECTIONS,
  discoverClaudeCode,
  HARNESS_PLATFORMS,
  LOST_UNKNOWNS,
  TURN_EVENT_KINDS,
  TURN_ORIGINS,
  TURN_RESULT_KINDS,
} from "../../src/harness/harness.js";

test("the closed vocabulary sets are exactly what the Interface fixes", () => {
  assert.deepEqual([...HARNESS_PLATFORMS], ["windows", "macos", "linux"]);
  assert.deepEqual([...TURN_ORIGINS], ["managed", "human"]);
  assert.deepEqual([...APPROVAL_DECISIONS], ["allow", "deny"]);
  assert.deepEqual(
    [...CONTROL_REJECTIONS],
    ["unsupported", "expired", "already-settled", "shape-mismatch"],
  );
  assert.deepEqual(
    [...TURN_RESULT_KINDS],
    ["not-started", "completed", "failed", "interrupted", "lost"],
  );
  assert.deepEqual(
    [...LOST_UNKNOWNS],
    ["acceptance", "completion", "interruption"],
  );
  assert.deepEqual(
    [...TURN_EVENT_KINDS],
    [
      "session",
      "assistant-content",
      "tool-activity",
      "request-raised",
      "request-answered",
      "request-expired",
      "preview",
      "context",
      "usage",
      "activity",
      "model",
    ],
  );
});

test("Claude Code discovery shares configured-then-PATH order and served capabilities", () => {
  const resolved: string[] = [];
  const discovery = discoverClaudeCode({
    configuredExecutable: "configured-claude",
    env: { SECANT_CLAUDE_CODE: "ignored-env-claude" },
    resolve(name) {
      resolved.push(name);
      return name === "claude" ? "/bin/claude" : undefined;
    },
  });

  assert.deepEqual(resolved, ["configured-claude", "claude"]);
  assert.equal(discovery.kind, "found");
  if (discovery.kind !== "found") throw new Error("unreachable");
  assert.equal(discovery.attempt.source, "path");
  assert.deepEqual(CLAUDE_CODE_SERVED_CAPABILITIES, {
    "agent-turn": true,
    "interactive-turns": true,
  });
});
