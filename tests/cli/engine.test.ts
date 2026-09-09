import assert from "node:assert/strict";
import test from "node:test";
import { withinEngineFloor } from "../../src/cli/main.js";

test("a Node below the required major is rejected", () => {
  assert.equal(withinEngineFloor(">=24.0.0", "v20.11.0"), false);
  assert.equal(withinEngineFloor(">=24.0.0", "v18.0.0"), false);
});

test("the required major and above are accepted", () => {
  assert.equal(withinEngineFloor(">=24.0.0", "v24.0.0"), true);
  assert.equal(withinEngineFloor(">=24.0.0", "v26.7.0"), true);
});
