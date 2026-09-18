import assert from "node:assert/strict";
import test from "node:test";
import { createCodexRecordingCapture } from "./codex-recording.js";

test("Codex recording preserves a UTF-8 stderr scalar split across chunks", () => {
  const capture = createCodexRecordingCapture();
  const bytes = new TextEncoder().encode("before → after\n");
  const split = bytes.indexOf(0xe2) + 1;
  capture.observer.stderr(bytes.subarray(0, split));
  capture.observer.stderr(bytes.subarray(split));
  capture.observer.closed("exited", 0);

  assert.equal(
    capture.traffic
      .filter((entry) => entry.direction === "stderr")
      .map((entry) => entry.line)
      .join(""),
    "before → after\n",
  );
  assert.deepEqual(capture.exit, { kind: "exited", status: 0 });
});
