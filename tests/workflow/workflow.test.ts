import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_TYPES,
  HUMAN_GATE_SHAPES,
  STEP_KINDS,
  STEP_KIND_NAMES,
  WORKSPACE_PREREQUISITES,
  hasOnlyValidPromptSlots,
  promptSlotReferences,
} from "../../src/workflow/workflow.js";

test("the closed vocabulary sets are exactly what the spec fixes", () => {
  assert.deepEqual(
    [...ARTIFACT_TYPES],
    ["text", "file", "file-set", "verdict", "choice"],
  );
  assert.deepEqual(
    [...STEP_KIND_NAMES],
    ["agent", "interactive-agent", "human-gate", "command"],
  );
  assert.deepEqual([...HUMAN_GATE_SHAPES], ["approve-reject", "free-text"]);
  assert.deepEqual([...WORKSPACE_PREREQUISITES], ["git-worktree-root"]);
});

test("every Step kind states the same seven facts", () => {
  const facts = [
    "kind",
    "requires",
    "produces",
    "session",
    "preconditions",
    "capabilityNeeds",
    "retryableOutcomes",
    "reconciliation",
  ];
  for (const name of STEP_KIND_NAMES) {
    assert.deepEqual(Object.keys(STEP_KINDS[name]).sort(), [...facts].sort());
  }
  // The Command step's products are fixed by the kind, not authored.
  assert.deepEqual(STEP_KINDS.command.produces, ["verdict", "text"]);
});

test("prompt slots read only {{artifact:name}} and reject expressions", () => {
  assert.deepEqual(
    promptSlotReferences("fix {{artifact:failing-test}} then {{artifact:log}}"),
    ["failing-test", "log"],
  );
  assert.equal(hasOnlyValidPromptSlots("use {{artifact:x}}"), true);
  assert.equal(hasOnlyValidPromptSlots("no {{if x}} logic"), false);
  assert.equal(hasOnlyValidPromptSlots("no {{asset:x}} either"), false);
});
