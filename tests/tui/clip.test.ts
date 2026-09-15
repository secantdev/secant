import assert from "node:assert/strict";
import { test } from "node:test";
import stringWidth from "string-width";
import { clip } from "../../src/tui/tui.js";

// `clip` truncates to display columns, not UTF-16 code units (D5). A wide glyph
// occupies two columns, so a `.length`-based clip would miscount and overflow the
// terminal width (tui/AGENTS.md: an overflowing row is corrupted, not clipped).

test("text within the width is returned unchanged", () => {
  assert.equal(clip("hello", 10), "hello");
  assert.equal(clip("hello", 5), "hello");
});

test("ASCII over the width truncates to exactly the width with an ellipsis", () => {
  const out = clip("hello world", 5);
  assert.equal(out, "hell…");
  assert.equal(stringWidth(out), 5);
});

test("a row of wide glyphs clips to the terminal width exactly", () => {
  // "你好世界" is four 2-column glyphs (8 columns). Clipped to 5 it must occupy
  // exactly 5 columns, never 6 — two glyphs (4) plus the 1-column ellipsis.
  const out = clip("你好世界", 5);
  assert.equal(stringWidth(out), 5);
  assert.equal(out, "你好…");
});

test("a trailing wide glyph never spills past the budget", () => {
  // Budget after the ellipsis is 3 columns; a second wide glyph (to column 4) must
  // not fit, so only one glyph precedes the marker.
  const out = clip("你a好", 4);
  assert.ok(stringWidth(out) <= 4, `width ${stringWidth(out)} exceeds 4`);
});

test("width of one or zero never overflows", () => {
  assert.equal(stringWidth(clip("你好", 1)), 1); // the ellipsis alone, not a 2-col glyph
  assert.equal(clip("anything", 0), "");
});
