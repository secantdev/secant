import assert from "node:assert/strict";
import test from "node:test";
import { withinEngineFloor } from "../../src/cli/main.js";

test("a Node below the required major is rejected", () => {
  assert.equal(withinEngineFloor(">=26.4.0", "v20.11.0"), false);
  assert.equal(withinEngineFloor(">=26.4.0", "v24.0.0"), false);
  assert.equal(withinEngineFloor(">=26.4.0", "v25.9.0"), false);
});

test("a Node at the required major but below the minor floor is rejected", () => {
  // OpenTUI's Node path needs experimental FFI, first in official Node 26.4.0.
  assert.equal(withinEngineFloor(">=26.4.0", "v26.0.0"), false);
  assert.equal(withinEngineFloor(">=26.4.0", "v26.3.0"), false);
});

test("the required major.minor and above are accepted", () => {
  assert.equal(withinEngineFloor(">=26.4.0", "v26.4.0"), true);
  assert.equal(withinEngineFloor(">=26.4.0", "v26.7.0"), true);
  assert.equal(withinEngineFloor(">=26.4.0", "v27.0.0"), true);
});
