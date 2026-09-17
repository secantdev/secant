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
- The Workbench bottom region is a modal stack (#121): an outstanding approval Harness Request or a free-text Human Gate owns Esc and every printable key, so
  while either is up the Run Actions rail (r/c/x) and the two-press Esc interrupt are suppressed (`modalControl()` gates `anyActionOffer`/`actionLines` and the
  interrupt disarm). `interrupt-turn`/`steer-turn` offers stay present through an `awaiting-approval` Turn (run-projection derives them from liveness, not
  `TurnPhase`), so without this guard the request control and the "esc esc interrupt" hint collide over Esc. The interrupt/steer rows and the Esc arm are also
  hidden while an interactive Step owns the input (#122): its Esc leaves, so surfacing an Esc-driven interrupt there would collide too.
- The free-text gate control is a hand-rolled text buffer over that raw-key pipeline, not a native `<input>`: the Workbench is Port-driven, so a native input on
  the keymap path never sees its keys. Single-char `name` only — shifted symbols and IME are deferred real-terminal input (#23).
- The timeline's scroll/live-edge/anchor/new-activity is a pure index reducer (`run-timeline.ts`), not OpenTUI's `<scrollbox>` (which OpenCode's session
  timeline uses). `run-timeline-rows.ts` joins append-only durable history with stable-key replaceable live tail rows; an absolute `top` keeps naming the
  same first-visible row while new rows land, and the new-activity count is `total − viewportBottom`. Neither invariant exists in the scrollbox.
- Exactly one screen mounts at a time (`app.tsx`), so a screen's key bindings exist only while it is active and cannot conflict with another's. And
  `useBindings({ enabled })` must be gated off while a dialog overlays a screen (the approval dialog over Home, `home.tsx`), or the overlaid screen's
  bindings fire under the dialog.
- `clip()` (`clip.ts`) is not the horizontal-overflow guard — a container's `overflow="hidden"` already clips at width. It is the ellipsis affordance:
  call it only on a row that should _advertise_ its truncation with a trailing `…` (a name, path, or status that can exceed the inner width), not on
  every row. It measures **display columns** with `string-width`, not `.length` (D5): a wide glyph is two columns, so a code-unit count would overflow.
- A launch resolves at **admission** (`run-launch-view.tsx`): the Run id is known and the Run is observable `running` at once (#98 A7), so the flow reaches
  the Workbench before the Run rests and the Workbench follows the live `run` Projection. Every _other_ write (answer, resume, cancel, delete) follows the
  operation stream to settlement through `submit-and-settle.ts`, because a Run — and a cancel-as-abort of a live Run — settles asynchronously now (#98).
  Captured command output is stripped of ANSI escapes with `strip-ansi` and split on `/\r?\n/` in the inspection read path (D4).
- Sanctioned Seam leak (A29): `createProductionRenderer` (`renderer/renderer.ts`) returns an `@opentui/core` `CliRenderer` that composition
  (`composition/tui-runtime.ts`) binds and hands to `mountTui`, so an inferred `@opentui/core` type crosses into composition where the boundary suite —
  which reads only import specifiers — cannot see it. Deliberate and ADR 0018-sanctioned: Solid's `render(node, renderer)` mounts onto that object while
  the Renderer Port keeps lifecycle. Recorded here because the check is blind to it.

## Tests

- Screens are exercised in-memory over fake Projection snapshots with `@opentui/solid` `testRender` (`tests/tui/*.test.tsx`): assert content, key
  dispatch, and small-width/resize relayout without overflow. A lone Escape is held briefly by OpenTUI key disambiguation — poll in real time, not by
  frame count.

- The interactive-agent input (`run-workbench.tsx`, #122) is a text field driven by the raw-key pipeline, not an OpenTUI `<input>`: while `focus` is `interactive` it owns
  every key, so `q`/`r`/`c`/`x`/`t` type rather than fire their bare-letter commands (only Ctrl+C still exits). Text accumulates from the key `name` (a single-char name types,
  `space`/`backspace` map through) — capitals and punctuation the Renderer Port does not name are out of reach until it carries the printable value. Enter dispatches
  `send-interactive-turn` (blank/whitespace refused before dispatch); Ctrl+E arms `end-interactive-step`, offered — and so armable — only at a Turn boundary (no live Turn),
  reusing the same `pending` arm-and-confirm. The Step is "active" whenever the Run is blocked at an `interactive-agent` Step (independent of a live Turn), so focus stays on
  the input across the whole Step and returns to the timeline when it ends.
- A destructive Run Action (cancel or delete) arms a confirming keypress before it dispatches (`run-workbench.tsx` `pending`): `y` confirms, Escape backs out.
  An ordinary resume dispatches at once; a resume Offer carrying a takeover form first confirms once and names the foreign owner process.
- The quit confirmation (`app.tsx` `GuardedExitProvider`/`QuitConfirmation`) lives on the vendored dialog stack, not a bare `<Show>` overlay: every screen's bindings are
  gated `dialog.stack.length === 0`, so being on the stack is what makes it modal (else `q`/`return` fire the underlying screen too). Escape/Ctrl+C dismissal comes from the
  dialog primitive. Route's approval-clear effect is a one-shot guarded on an `approvalOpen` signal so it never clears the quit dialog, and the approval dialog's `onClose`
  declines only while still unapproved — a programmatic clear once approved is not a decline.

## Read next

- Each screen reads the Projection Port through a per-screen view seam (`workspace-view.tsx`, `bundle-view.tsx`, `run-view.tsx` — the reactive `run` read +
  reference resolution the Workbench uses; `run-list-view.tsx` — the Previous Runs read seam that pages older rows by cursor and appends them, the only
  seam that re-opens its Projection to grow a page); a write goes through a per-screen submit seam (`run-actions-view.tsx` — resume/cancel/delete, mirroring
  `run-launch-view.tsx`). The Renderer Port (`renderer/renderer.ts`) carries lifecycle plus the Workbench's `size`/`onKey`/`onResize`, and declares its key
  value (`{ name?, ctrl? }`, A16) so the Workbench needs no cast.
- Two private helpers back those seams: `follow.ts` (`followProjection`) is the one follow-snapshot loop the read seams share (A22); `submit-and-settle.ts`
  (`submitAndSettle`) is the one submit-then-follow-the-operation-stream loop the write seams share (A23). `run-inspection.tsx` holds the Workbench's
  reference-inspection overlay — its state, key loop, and view — split out of `run-workbench.tsx` (A26).
- `previous-runs.tsx` is the Previous Runs screen (the list reached from Home; reuses the single-active-index selection model of `bundle-list.tsx`).
- `clip.ts` is the ellipsis affordance above, and `bundle-format.ts` holds the Bundle-screen status wording — keep it matching `headless/render.ts` so
  the TUI and headless surfaces say the same thing about the same fact.
