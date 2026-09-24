# tui — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- OpenTUI `<text>` lays out multiple children as separate inline spans, which garbles a line (fragments drop or overlap). Give every `<text>` a single
  concatenated string child, not a mix of literals and `{expr}` siblings.
- A flex column with a fixed `height` shrinks overflowing children to fit, corrupting their content rather than clipping. When a screen's content can
  exceed the terminal height, set `overflow="hidden"` on the container and `flexShrink={0}` on the rows/sections so each keeps its full height. A screen
  that owns a bounded `<scrollbox>` still keeps full-height content rows inside it; scroll does not replace the guard.
- A focused OpenTUI `<input>` and the `@opentui/keymap` layer divide keys by binding: any key the keymap binds fires its command even while an input is focused; only
  unbound printable keys and backspace reach the input. So never bind a bare letter key (e.g. `q` to quit) on a text-entry screen, and gate `left`/`right` with a reactive
  `enabled` so choice/verdict fields cycle without stealing a text field's cursor. Native `<input>`/`<select>`/`<textarea>` exist — no need to hand-roll a caret.
- The Run Workbench (`run-workbench.tsx`) is the one screen that takes its keys, size, and resize from the injected Renderer Port (`size`/`onKey`/`onResize`,
  A13) instead of `@opentui/keymap` + `useTerminalDimensions`: a single raw-key pipeline drives every control, so its input and layout are driven by a fake
  renderer in tests. Every other screen keeps the keymap/`useTerminalDimensions` path. Drawing still goes through OpenTUI elements — the Port never carries it.
- `follow.ts` alone owns Projection observer health and reconnect ordering. A terminal update preserves last-known state as `disconnected`; explicit reconnect
  crosses `loading` and `catching-up` before `current`. Workbench Operation controls read only current offers, while timeline live-edge remains a separate scroll fact.
- The timeline's scroll/live-edge/anchor/new-activity is a pure index reducer (`run-timeline.ts`), not OpenTUI's `<scrollbox>` (which OpenCode's session
  timeline uses). `run-timeline-rows.ts` joins append-only durable history with stable-key replaceable live tail rows; an absolute `top` keeps naming the
  same first-visible row while new rows land, and the new-activity count is `total − viewportBottom`. Neither invariant exists in the scrollbox.
- Exactly one screen mounts at a time (`app.tsx`), so a screen's key bindings exist only while it is active and cannot conflict with another's. And
  `useBindings({ enabled })` must be gated off while a dialog overlays a screen (the approval dialog over Home, `home.tsx`), or the overlaid screen's
  bindings fire under the dialog.
- Start a Run skips Harness/model for Command-only Bundles; Agent-bearing Bundles use the Harness catalog's worded rows and supported-model declaration. Review opens a
  fresh `launch-preparation` Projection for the complete draft, offers Start only while ready, and submits that Projection's exact `launch-run` draft (#191/#192).
- A refused launch routes only by `correction`, clears only the invalidated draft field, preserves every other choice, and keeps its inline finding after the dismissible
  `Run not started` notice leaves. A typed preparation failure after admission still rides the Run Projection into the Workbench (#146).
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
- The quit confirmation (`app.tsx` `GuardedExitProvider`/`QuitConfirmation`) lives on the vendored dialog stack, not a bare `<Show>` overlay: every screen's bindings are
  gated `dialog.stack.length === 0`, so being on the stack is what makes it modal (else `q`/`return` fire the underlying screen too). Escape/Ctrl+C dismissal comes from the
  dialog primitive. Route's approval-clear effect is a one-shot guarded on an `approvalOpen` signal so it never clears the quit dialog, and the approval dialog's `onClose`
  declines only while still unapproved — a programmatic clear once approved is not a decline.

## Tests

- Screens are exercised in-memory over fake Projection snapshots with `@opentui/solid` `testRender` (`tests/tui/*.test.tsx`): assert content, key
  dispatch, and small-width/resize relayout without overflow. A lone Escape is held briefly by OpenTUI key disambiguation — poll in real time, not by
  frame count.

## Read next

- Each screen reads the Projection Port through a per-screen view seam (`workspace-view.tsx`, `bundle-view.tsx`, `run-view.tsx` — the reactive `run` read +
  reference resolution the Workbench uses; `run-list-view.tsx` — the Previous Runs read seam that pages older rows by cursor and appends them, the only
  seam that re-opens its Projection to grow a page); a write goes through a per-screen submit seam (`run-actions-view.tsx` — resume/cancel/delete, mirroring
  `run-launch-view.tsx`). The Renderer Port (`renderer/renderer.ts`) carries lifecycle plus the Workbench's `size`/`onKey`/`onResize`, and declares its key
  value (`{ name?, ctrl? }`, A16) so the Workbench needs no cast.
- `catalog-navigation.tsx` (A4) owns both catalogs' search, pane focus, selection, bindings, and row/empty shells, on the vendored two-pane
  `vendor/panels.tsx` and bounded `vendor/scroll.ts` primitives (see `UPSTREAM`); filters, focus, and inspectors stay per screen.
  `bundle-catalog.tsx` renders `bundle-view.tsx` via pure `bundle-catalog-inspector.tsx`; neither adds an Action Offer or Projection selector.
- `harness-catalog.tsx` opens exact focus for the selected row and rehydrates only rows the list already marks checked, retaining those accessors for search;
  `harness-view.tsx` keeps list opening spawn-free, `harness-format.ts` owns shared wording, and the inspector renders normalized facts with no Actions.
- Two private helpers back those seams: `follow.ts` (`followProjection`) owns the read seams' follow, health, and reconnect loop (A22); `submit-and-settle.ts`
  (`submitAndSettle`) owns submit-then-follow and reopens a lost pending Operation receipt (A23).
- Read [tui-workbench](../../docs/agents/tui-workbench.md) before changing the Run Workbench's key routing, modal stack, steer compose, interactive input,
  destructive confirms, or details panel.
- `start-run-views.tsx` holds Start a Run's step components and leaves; the draft signal, step transitions, and refusal routing stay in `start-run.tsx` (A3).
  Each step owns its transient UI state and its own `useBindings`, and `ReviewStep` opens the `launch-preparation` Projection directly (#231 A16).
- `previous-runs.tsx` is the Previous Runs screen reached from Home.
- `clip.ts` is the ellipsis affordance above, and `bundle-format.ts` holds the Bundle-catalog status wording — keep it matching `headless/render.ts` so
  the TUI and headless surfaces say the same thing about the same fact.
