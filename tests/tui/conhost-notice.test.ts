import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONHOST_NOTICE,
  printConhostNotice,
} from "../../src/tui/renderer/renderer.js";

// Both guard branches, exercised on every OS with a fake probe — no Windows API
// is touched. The production `bun:ffi` probe is validated by the human check.

test("prints the notice when the probe reports a visible conhost window", () => {
  const written: string[] = [];
  printConhostNotice(
    () => true,
    (text) => written.push(text),
    false,
  );
  assert.deepEqual(written, [CONHOST_NOTICE]);
});

test("suppresses the notice when the probe reports no conhost window", () => {
  const written: string[] = [];
  printConhostNotice(
    () => false,
    (text) => written.push(text),
    false,
  );
  assert.deepEqual(written, []);
});

test("suppresses the notice in Windows Terminal even when its console window is visible", () => {
  const written: string[] = [];

  printConhostNotice(
    () => true,
    (text) => written.push(text),
    true,
  );

  assert.deepEqual(written, []);
});
