import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AT_LIVE,
  scrollTimeline,
  TIMELINE_PAGE,
  timelineWindow,
  type TimelineScroll,
} from "../../src/tui/tui.js";

// The pure timeline scroll model (#91 AC3): live-edge following, the new-activity
// count, the append-only prepend anchor, page/threshold sizing, and jump-to-latest.

test("live edge shows the newest viewport of events and counts no new activity", () => {
  const w = timelineWindow(AT_LIVE, 20, 5);
  assert.deepEqual(w, { top: 15, visible: 5, newActivity: 0, atLive: true });
});

test("a short timeline (fewer events than the viewport) is fully visible at the top", () => {
  const w = timelineWindow(AT_LIVE, 3, 10);
  assert.deepEqual(w, { top: 0, visible: 3, newActivity: 0, atLive: true });
});

test("scrolling up from the live edge pauses and counts the events below the viewport", () => {
  const up = scrollTimeline(AT_LIVE, "up", 20, 5); // live top was 15 → 14
  assert.deepEqual(up, { mode: "paused", top: 14 });
  const w = timelineWindow(up, 20, 5);
  assert.equal(w.top, 14);
  assert.equal(w.visible, 5); // rows 14..18
  assert.equal(w.newActivity, 1); // row 19 sits below the viewport
  assert.equal(w.atLive, false);
});

test("the first visible row stays anchored as newer events append, and new-activity grows", () => {
  const paused: TimelineScroll = { mode: "paused", top: 4 };
  const before = timelineWindow(paused, 20, 5);
  assert.equal(before.top, 4);
  assert.equal(before.newActivity, 20 - (4 + 5)); // 11 below
  // Three durable events land at the end; the pinned index still names the same
  // first visible event, and the unseen-below count rises by three.
  const after = timelineWindow(paused, 23, 5);
  assert.equal(after.top, 4, "first visible row anchored under append");
  assert.equal(after.newActivity, before.newActivity + 3);
});

test("jump-to-latest returns to the live edge and clears the new-activity count", () => {
  const paused: TimelineScroll = { mode: "paused", top: 2 };
  const latest = scrollTimeline(paused, "latest", 40, 6);
  assert.deepEqual(latest, AT_LIVE);
  assert.equal(timelineWindow(latest, 40, 6).newActivity, 0);
});

test("scrolling down to the bottom re-attaches to the live edge so events follow again", () => {
  // One row above the bottom, a down lands on the last page → re-follow.
  const nearBottom: TimelineScroll = { mode: "paused", top: 14 }; // maxTop for 20/5 is 15
  assert.deepEqual(scrollTimeline(nearBottom, "down", 20, 5), AT_LIVE);
});

test("page-up moves by the documented page size and clamps at the top", () => {
  const start = scrollTimeline(AT_LIVE, "up", 100, 10); // paused top 89
  const up = scrollTimeline(start, "pageUp", 100, 10);
  assert.deepEqual(up, { mode: "paused", top: 89 - TIMELINE_PAGE });
  const top = scrollTimeline({ mode: "paused", top: 4 }, "pageUp", 100, 10);
  assert.deepEqual(
    top,
    { mode: "paused", top: 0 },
    "clamps at the first event",
  );
});

test("top jumps to the oldest event; on a short timeline it stays at the live edge", () => {
  assert.deepEqual(scrollTimeline(AT_LIVE, "top", 50, 10), {
    mode: "paused",
    top: 0,
  });
  assert.deepEqual(scrollTimeline(AT_LIVE, "top", 4, 10), AT_LIVE);
});

test("an empty timeline stays at the live edge with nothing visible", () => {
  const w = timelineWindow(AT_LIVE, 0, 8);
  assert.deepEqual(w, { top: 0, visible: 0, newActivity: 0, atLive: true });
  assert.deepEqual(scrollTimeline(AT_LIVE, "up", 0, 8), AT_LIVE);
});
