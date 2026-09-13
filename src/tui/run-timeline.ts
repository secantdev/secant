// The Run Workbench timeline's scroll model as a pure reducer over the event
// array's indices — deliberately NOT OpenTUI's `<scrollbox>`. Upstream OpenCode
// (routes/session/index.tsx @ 1ead9e3d7f) follows the live edge with the
// scrollbox's `stickyScroll`/`stickyStart="bottom"` and has no new-activity
// counter or prepend anchor; those are net-new here (#91 AC3). Indexing the
// window by absolute event index — not pixel offset — is what makes the anchor
// and the new-activity count exact and unit-testable: the timeline is
// append-only (durable events land at the end as each publication commits), so a
// held `top` index keeps naming the same event as newer ones arrive.

/** Page size for pageUp/pageDown, and the effective upward-load increment (#91
 *  AC3). The whole bounded timeline is already in the snapshot, so "loading older
 *  rows" is windowing over stable indices rather than fetching a page — there is
 *  no separate load threshold to tune, and the append-only anchor holds for free. */
export const TIMELINE_PAGE = 10;

/** `live` sticks to the newest events (the live edge); `paused` pins the first
 *  visible row to an absolute event index while the user reads older activity. */
export type TimelineScroll =
  { readonly mode: "live" } | { readonly mode: "paused"; readonly top: number };

export const AT_LIVE: TimelineScroll = { mode: "live" };

export interface TimelineWindow {
  /** Index of the first visible event. */
  readonly top: number;
  /** Count of visible events (at most the viewport height). */
  readonly visible: number;
  /** Events below the viewport bottom — the newest activity not yet scrolled to;
   *  0 while following the live edge. */
  readonly newActivity: number;
  readonly atLive: boolean;
}

export type TimelineAction =
  "up" | "down" | "pageUp" | "pageDown" | "top" | "latest";

/** The visible window for a scroll state over `total` events in a `viewport`-tall
 *  area. `live` shows the newest `viewport` events; `paused` shows `viewport`
 *  events from its pinned `top`, clamped so it never scrolls past the ends. */
export function timelineWindow(
  scroll: TimelineScroll,
  total: number,
  viewport: number,
): TimelineWindow {
  const height = Math.max(1, viewport);
  const maxTop = Math.max(0, total - height);
  if (scroll.mode === "live") {
    return {
      top: maxTop,
      visible: Math.min(height, total),
      newActivity: 0,
      atLive: true,
    };
  }
  const top = clamp(scroll.top, 0, maxTop);
  const bottom = Math.min(total, top + height);
  return {
    top,
    visible: bottom - top,
    newActivity: total - bottom,
    atLive: false,
  };
}

/** Apply one scroll action. Reaching the bottom re-attaches to the live edge so
 *  later events follow again; `latest` jumps straight there. */
export function scrollTimeline(
  scroll: TimelineScroll,
  action: TimelineAction,
  total: number,
  viewport: number,
): TimelineScroll {
  const height = Math.max(1, viewport);
  const maxTop = Math.max(0, total - height);
  const currentTop =
    scroll.mode === "live" ? maxTop : clamp(scroll.top, 0, maxTop);
  switch (action) {
    case "latest":
      return AT_LIVE;
    case "top":
      return maxTop === 0 ? AT_LIVE : { mode: "paused", top: 0 };
    case "up":
      return pauseAt(currentTop - 1, maxTop);
    case "down":
      return pauseAt(currentTop + 1, maxTop);
    case "pageUp":
      return pauseAt(currentTop - TIMELINE_PAGE, maxTop);
    case "pageDown":
      return pauseAt(currentTop + TIMELINE_PAGE, maxTop);
  }
}

function pauseAt(top: number, maxTop: number): TimelineScroll {
  const clamped = clamp(top, 0, maxTop);
  // At (or past) the bottom, re-follow the live edge; otherwise pin the index.
  return clamped >= maxTop ? AT_LIVE : { mode: "paused", top: clamped };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
