import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakeRenderer,
  createTeardown,
  type RendererPort,
  type StdinRelease,
} from "../../src/tui/renderer/renderer.js";

/** A fake port that records when it is destroyed, into a shared order log. */
function recordingPort(order: string[]): RendererPort {
  const fake = createFakeRenderer();
  return {
    ...fake,
    destroy() {
      order.push("destroy");
      fake.destroy();
    },
    get destroyed() {
      return fake.destroyed;
    },
  };
}

function recordingStdin(order: string[]): StdinRelease {
  return {
    release() {
      order.push("stdin");
    },
  };
}

test("teardown releases stdin before destroying the renderer", () => {
  const order: string[] = [];
  const teardown = createTeardown(recordingStdin(order), recordingPort(order));
  teardown();
  // The invariant: stdin must precede destroy (anomalyco/opentui#1405). This
  // assertion fails if the two steps are ever reversed.
  assert.deepEqual(order, ["stdin", "destroy"]);
});

test("teardown runs exactly once across every exit path", () => {
  const order: string[] = [];
  const port = recordingPort(order);
  let onTeardownCalls = 0;
  const teardown = createTeardown(recordingStdin(order), port, () => {
    onTeardownCalls++;
  });
  teardown();
  teardown();
  teardown();
  assert.deepEqual(order, ["stdin", "destroy"]);
  assert.equal(port.destroyed, true);
  // onTeardown fires on the one admitted call, so the diagnostic side channel
  // records the single teardown exactly once no matter how many paths call it.
  assert.equal(onTeardownCalls, 1);
});
