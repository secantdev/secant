# tui — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- OpenTUI `<text>` lays out multiple children as separate inline spans, which garbles a line (fragments drop or overlap). Give every `<text>` a single
  concatenated string child, not a mix of literals and `{expr}` siblings.
- A flex column with a fixed `height` shrinks overflowing children to fit, corrupting their content rather than clipping. When a screen's content can
  exceed the terminal height, set `overflow="hidden"` on the container and `flexShrink={0}` on the rows/sections so each keeps its full height. Vertical
  scroll for long content is a later slice, not a reason to drop this guard.

## Tests

- Screens are exercised in-memory over fake Projection snapshots with `@opentui/solid` `testRender` (`tests/tui/*.test.tsx`): assert content, key
  dispatch, and small-width/resize relayout without overflow. A lone Escape is held briefly by OpenTUI key disambiguation — poll in real time, not by
  frame count.

## Read next

- Each screen reads the Projection Port through a per-screen view seam (`workspace-view.tsx`, `bundle-view.tsx`); the Renderer Port stays
  lifecycle-only (`renderer/renderer.ts`).
