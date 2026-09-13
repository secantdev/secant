# tui — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- OpenTUI `<text>` lays out multiple children as separate inline spans, which garbles a line (fragments drop or overlap). Give every `<text>` a single
  concatenated string child, not a mix of literals and `{expr}` siblings.
- A flex column with a fixed `height` shrinks overflowing children to fit, corrupting their content rather than clipping. When a screen's content can
  exceed the terminal height, set `overflow="hidden"` on the container and `flexShrink={0}` on the rows/sections so each keeps its full height. Vertical
  scroll for long content is a later slice, not a reason to drop this guard.
- A focused OpenTUI `<input>` and the `@opentui/keymap` layer divide keys by binding: any key the keymap binds fires its command even while an input is
  focused; only unbound printable keys and backspace reach the input. So never bind a bare letter key (e.g. `q` to quit) on a text-entry screen, and gate
  `left`/`right` with a reactive `enabled` so choice/verdict fields cycle without stealing a text field's cursor. Native `<input>`/`<select>`/`<textarea>`
  exist — no need to hand-roll a caret.
- The Run Workbench (`run-workbench.tsx`) is the one screen that takes its keys, size, and resize from the injected Renderer Port (`size`/`onKey`/`onResize`,
  A13) instead of `@opentui/keymap` + `useTerminalDimensions`: a single raw-key pipeline drives every control, so its input and layout are driven by a fake
  renderer in tests. Every other screen keeps the keymap/`useTerminalDimensions` path. Drawing still goes through OpenTUI elements — the Port never carries it.
- The timeline's scroll/live-edge/anchor/new-activity is a pure index reducer (`run-timeline.ts`), not OpenTUI's `<scrollbox>` (which OpenCode's session
  timeline uses): the durable timeline is append-only, so an absolute `top` index keeps naming the same first-visible event as newer events land — that
  append-stability _is_ the prepend anchor, and the new-activity count is `total − viewportBottom`. Neither exists in the scrollbox.

## Tests

- Screens are exercised in-memory over fake Projection snapshots with `@opentui/solid` `testRender` (`tests/tui/*.test.tsx`): assert content, key
  dispatch, and small-width/resize relayout without overflow. A lone Escape is held briefly by OpenTUI key disambiguation — poll in real time, not by
  frame count.

## Read next

- Each screen reads the Projection Port through a per-screen view seam (`workspace-view.tsx`, `bundle-view.tsx`, `run-view.tsx` — the reactive `run` read +
  reference resolution the Workbench uses); the Renderer Port (`renderer/renderer.ts`) carries lifecycle plus the Workbench's `size`/`onKey`/`onResize`.
