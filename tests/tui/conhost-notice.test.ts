import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  CONHOST_NOTICE,
  CONHOST_NOTICE_EXIT_CODE,
  createStdinKeypress,
  runBehindConhostNotice,
  type ConhostNoticeGate,
  type KeypressInput,
} from "../../src/tui/renderer/renderer.js";

// Every guard branch, exercised on every OS with a fake probe and a fake
// keypress — no Windows API and no real stdin is touched. The production
// `bun:ffi` probe is validated by the human legacy-conhost check.

function gate(overrides: Partial<ConhostNoticeGate>) {
  const written: string[] = [];
  const events: string[] = [];
  const deps: ConhostNoticeGate = {
    probe: () => true,
    isWindowsTerminalSession: false,
    write: (text) => {
      written.push(text);
      events.push("notice");
    },
    waitForKeypress: async () => {
      events.push("wait");
      return "continue";
    },
    ...overrides,
  };
  const launch = async () => {
    events.push("launch");
    return 7;
  };
  return { deps, launch, written, events };
}

test("a detected conhost window prints the notice, waits for a key, then launches", async () => {
  const { deps, launch, written, events } = gate({});

  const code = await runBehindConhostNotice(deps, launch);

  assert.equal(code, 7);
  assert.deepEqual(written, [CONHOST_NOTICE]);
  assert.deepEqual(events, ["notice", "wait", "launch"]);
});

test("the notice names the keypress and the Ctrl+C exit in words", () => {
  assert.match(CONHOST_NOTICE, /Press any key to continue/);
  assert.match(CONHOST_NOTICE, /Ctrl\+C to exit/);
});

test("Ctrl+C at the wait exits without launching the TUI", async () => {
  const { deps, launch, events } = gate({
    waitForKeypress: async () => {
      events.push("wait");
      return "exit";
    },
  });

  const code = await runBehindConhostNotice(deps, launch);

  assert.equal(code, CONHOST_NOTICE_EXIT_CODE);
  assert.equal(CONHOST_NOTICE_EXIT_CODE, 130);
  assert.deepEqual(events, ["notice", "wait"]);
});

test("no conhost window: no notice, no wait, immediate launch", async () => {
  const { deps, launch, written, events } = gate({ probe: () => false });

  assert.equal(await runBehindConhostNotice(deps, launch), 7);
  assert.deepEqual(written, []);
  assert.deepEqual(events, ["launch"]);
});

test("Windows Terminal: no notice, no wait, and the probe is never consulted", async () => {
  let probed = false;
  const { deps, launch, written, events } = gate({
    probe: () => {
      probed = true;
      return true;
    },
    isWindowsTerminalSession: true,
  });

  assert.equal(await runBehindConhostNotice(deps, launch), 7);
  assert.equal(probed, false);
  assert.deepEqual(written, []);
  assert.deepEqual(events, ["launch"]);
});

// A fake stdin recording raw mode and flow state, so the keypress read proves
// it hands stdin back paused, cooked, and listener-free before OpenTUI takes it
// (the anomalyco/opentui#1405 stdin-release invariant, applied at startup).
class FakeStdin extends EventEmitter implements KeypressInput {
  raw = false;
  flowing = false;
  readonly rawHistory: boolean[] = [];
  setRawMode(mode: boolean) {
    this.raw = mode;
    this.rawHistory.push(mode);
    return this;
  }
  resume() {
    this.flowing = true;
    return this;
  }
  pause() {
    this.flowing = false;
    return this;
  }
}

function assertReleased(stdin: FakeStdin) {
  assert.equal(stdin.raw, false);
  assert.equal(stdin.flowing, false);
  assert.equal(stdin.listenerCount("data"), 0);
  assert.equal(stdin.listenerCount("end"), 0);
  assert.deepEqual(stdin.rawHistory, [true, false]);
}

for (const [label, chunk] of [
  ["a letter", Buffer.from("a")],
  ["Enter", Buffer.from("\r")],
  ["an arrow-key escape sequence", Buffer.from("\x1b[A")],
] as const) {
  test(`any key (${label}) continues and releases stdin`, async () => {
    const stdin = new FakeStdin();
    const wait = createStdinKeypress(stdin)();
    assert.equal(stdin.raw, true);
    assert.equal(stdin.flowing, true);

    stdin.emit("data", chunk);

    assert.equal(await wait, "continue");
    assertReleased(stdin);
  });
}

test("Ctrl+C in raw mode (0x03) exits and releases stdin", async () => {
  const stdin = new FakeStdin();
  const wait = createStdinKeypress(stdin)();

  stdin.emit("data", Buffer.from("\x03"));

  assert.equal(await wait, "exit");
  assertReleased(stdin);
});

test("stdin closing at the wait exits instead of hanging", async () => {
  const stdin = new FakeStdin();
  const wait = createStdinKeypress(stdin)();

  stdin.emit("end");

  assert.equal(await wait, "exit");
  assertReleased(stdin);
});
