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
  WORKING_AREA_SLOT,
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

test("the one Run-owned reference slot names the Run working area (#214)", () => {
  assert.equal(WORKING_AREA_SLOT, "{{run:working-area}}");
  assert.equal(hasOnlyValidPromptSlots(`write in ${WORKING_AREA_SLOT}`), true);
  // It is not an artifact reference, so it adds no required binding.
  assert.deepEqual(promptSlotReferences(WORKING_AREA_SLOT), []);
  assert.equal(hasOnlyValidPromptSlots("no {{run:store-root}}"), false);
  assert.equal(hasOnlyValidPromptSlots("no {{run:}}"), false);
});
