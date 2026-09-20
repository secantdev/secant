import assert from "node:assert/strict";
import test from "node:test";
import { runNamedScenario } from "../../scripts/package-smoke/scenario.js";

test("a package-smoke failure names its scenario and preserves the cause", async () => {
  const cause = new Error("the assertion failed");

  await assert.rejects(
    runNamedScenario("install-and-collision", async () => {
      throw cause;
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /install-and-collision/);
      assert.equal(error.cause, cause);
      return true;
    },
  );
});
