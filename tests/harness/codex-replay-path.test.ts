import assert from "node:assert/strict";
import test from "node:test";
import { replayRecordedLine } from "./codex-replay-path.js";

test("recorded Workspace descendants use the replay host's path separator", () => {
  const recorded =
    '{"text":"read «WORKSPACE»/sum.test.mjs","cwd":"«WORKSPACE»"}\n';
  assert.equal(
    replayRecordedLine(recorded, "D:\\a\\secant\\workspace", "\\"),
    '{"text":"read D:\\\\a\\\\secant\\\\workspace\\\\sum.test.mjs","cwd":"D:\\\\a\\\\secant\\\\workspace"}\n',
  );
});
