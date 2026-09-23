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
- The Workbench bottom region is a modal stack (#121): an outstanding approval Harness Request or a free-text Human Gate owns Esc and every printable key, so
  while either is up the Run Actions rail (r/c/x) and the two-press Esc interrupt are suppressed (`modalControl()` gates `anyActionOffer`/`actionLines` and the
  interrupt disarm). `interrupt-turn`/`steer-turn` offers stay present through an `awaiting-approval` Turn (run-projection derives them from liveness, not
  `TurnPhase`), so without this guard the request control and the "esc esc interrupt" hint collide over Esc. The interrupt/steer rows and the Esc arm are also
  hidden while an interactive Step owns the input (#122): its Esc leaves, so surfacing an Esc-driven interrupt there would collide too.
- Native Steer (#148) is an on-demand compose, not a blocked-state modal like the gate/interactive inputs: while an agent Turn is live under a Harness that declares native
  steer (Codex offers `steer-turn` `available`, Claude Code `available:false`), the Actions rail names the `s` key; `s` opens a native `<input>` (`SteerInput`) in the bottom
  region with `focus === "steer"`, Enter dispatches `steer-turn` (blank refused, a refused steer keeps the draft), Escape backs out — the Turn keeps working either way. It is
  mutually exclusive with the interactive input (a Turn is live vs. the Run is blocked) and yields to a request/gate modal (`modalControl` wins `bottomHeight`; an effect
  closes the compose when the offer leaves or a modal appears). The `s`-open and steer-typing key routing sit beside the interactive `typing` branch (gated so
  `q`/`t`/Run-Actions type as text while composing). An unavailable steer shows `steer — unavailable · <reason>` and `s` opens nothing.
- The free-text gate control and the interactive input each mount a native OpenTUI `<input>` (`run-gate-control.tsx`, `run-workbench.tsx`; D9), not a hand-rolled
  buffer. The verified routing order is why this works on the Port-driven Workbench: OpenTUI delivers a keypress to the global listeners registered on `keyInput`
  **before** the focused renderable's own handler, and the production Renderer Port adapter (`renderer/renderer.ts`, `renderer.keyInput.on("keypress", …)`) is exactly
  such a global listener, so the Workbench dispatcher runs first and always fires its command — a focused field can never preempt a command key. The dispatcher claims
  the command keys (Enter to submit, Esc to leave/deny, Ctrl+E to arm End Step, `y` to confirm) and lets every other key reach the field, which owns text, cursor motion,
  word delete, paste, and shifted symbols (so capitals and punctuation are no longer out of reach — the #23 shifted-symbol deferral is retired for these two controls).
- We do **not** call `stopPropagation` (the narrow Port key value carries no such method, A16), so the focused field also receives a command key by its own bindings. That
  is harmless because the freeze blurs the field for the keys that would double: the field is blurred (`focused` false) while an answer is in flight and while a confirming
  keypress is armed, so the confirming `y` confirms rather than types. The `pending()` check still sits **above** the typing branch in the Workbench key loop
  (`run-workbench.tsx`), so an armed End-Step confirm takes `y`/Escape. The one non-frozen double is Ctrl+E: it arms End Step and, on the same event, the field also runs its
  built-in Ctrl+E→line-end before the arm blurs it — a moot cursor move, so the bindings override the research left optional is deferred.
- A stale approval answer keeps its inline refusal while the offer re-renders: a genuinely new request (a fresh `requestId`) resets the decision to `allow`
  and clears the refusal, but a stale answer keeps the same id, so its refusal survives while the bumped-generation offer re-renders (`onIdentityChange` on
  the request id).
- A live update is told from a durable one by kind, and the settling watermark drives the preview-to-authoritative swap (`reduceRunUpdate`, `run-view.tsx`):
  a `live` overlay at phase `settling` records the durable `settledCountAtSettling`; the next `durable` update whose settled-Turn count passes it drops the
  live overlay and preview and shows the authoritative snapshot alone. A `preview` update only refreshes the streaming text.
- `follow.ts` alone owns Projection observer health and reconnect ordering. A terminal update preserves last-known state as `disconnected`; explicit reconnect
  crosses `loading` and `catching-up` before `current`. Workbench Operation controls read only current offers, while timeline live-edge remains a separate scroll fact.
- Typed-but-unsent interactive text (the `draft` signal) clears only on a **fresh** interactive Step (the focus effect keyed on the Step id), so it survives a
  Turn settle and a tab away within the same Step; a send clears it optimistically before dispatch, so a refused send loses the text (the refusal re-surfaces,
  the draft does not).
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

## Tests

- Screens are exercised in-memory over fake Projection snapshots with `@opentui/solid` `testRender` (`tests/tui/*.test.tsx`): assert content, key
  dispatch, and small-width/resize relayout without overflow. A lone Escape is held briefly by OpenTUI key disambiguation — poll in real time, not by
  frame count.

- The interactive-agent input (`run-workbench.tsx`, #122) is a native OpenTUI `<input>` (D9): while `focus` is `interactive` the field owns text, so `q`/`r`/`c`/`x`/`t`
  type into it rather than fire their bare-letter commands (only Ctrl+C still exits, and the dispatcher gates those commands on not typing). The field carries capitals,
  punctuation, paste and word delete verbatim. Enter dispatches `send-interactive-turn` (blank/whitespace refused before dispatch, and a refused send keeps the draft, A9);
  Ctrl+E arms `end-interactive-step`, offered — and so armable — only at a Turn boundary (no live Turn), reusing the same `pending` arm-and-confirm. The Step is "active"
  whenever the Run is blocked at an `interactive-agent` Step (independent of a live Turn), so focus stays on the input across the whole Step and returns to the timeline when
  it ends. In tests, text rides `testRender`'s mock input (the field's real key source) while the dispatcher's command keys ride the fake Renderer Port.
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
- `catalog-navigation.tsx` (A4) owns both catalogs' search, pane focus, selection, bindings, and row/empty shells, on the vendored two-pane
  `vendor/panels.tsx` and bounded `vendor/scroll.ts` primitives (see `UPSTREAM`); filters, focus, and inspectors stay per screen.
  `bundle-catalog.tsx` renders `bundle-view.tsx` via pure `bundle-catalog-inspector.tsx`; neither adds an Action Offer or Projection selector.
- `harness-catalog.tsx` opens exact focus for the selected row and rehydrates only rows the list already marks checked, retaining those accessors for search;
  `harness-view.tsx` keeps list opening spawn-free, `harness-format.ts` owns shared wording, and the inspector renders normalized facts with no Actions.
- Two private helpers back those seams: `follow.ts` (`followProjection`) owns the read seams' follow, health, and reconnect loop (A22); `submit-and-settle.ts`
  (`submitAndSettle`) owns submit-then-follow and reopens a lost pending Operation receipt (A23). `run-inspection.tsx` holds the Workbench's
  reference-inspection overlay — its state, key loop, and view — split out of `run-workbench.tsx` (A26). `run-workbench-views.tsx` holds the Workbench's
  four pure presentational leaves; state, focus, modal precedence, and the key dispatcher stay in `run-workbench.tsx` (A12).
- `start-run-views.tsx` holds Start a Run's step components and leaves; the draft signal, step transitions, refusal routing, and key dispatcher stay in `start-run.tsx` (A3).
- `previous-runs.tsx` is the Previous Runs screen reached from Home; its single-active-index selection descends from the historical `bundle-list.tsx`.
- `clip.ts` is the ellipsis affordance above, and `bundle-format.ts` holds the Bundle-catalog status wording — keep it matching `headless/render.ts` so
  the TUI and headless surfaces say the same thing about the same fact.
- The Harness/model facts (#125/#147), recovery evidence, the story-38 resting reason, and cancel/delete moved off the header/rail into the details panel (#194).
  `buildDetailsRows` (`run-workbench-views.tsx`) builds the panel once; the container reserves exactly `detailsRows().length` rows, so render and row accounting
  never drift. Recovery lines appear only when their Run-view fact is present. `c`/`x` act only while the panel is shown, confirm in the panel; the rail keeps only
  resume and the live-Turn interrupt/steer. A terminal/`halted` rest also shows one `restingProse` line beside the header state word (colour is never the only
  signal); `blocked` keeps that prose only in the panel, and `headerRows()` counts it.
- `ResumeRunOffer` is a `SteerTurnOffer`-style union (#194): `available:false` renders `resume — unavailable · <reason>` and `r` no-ops (story 40); an
  `available:true` offer with `acknowledgement` arms an extra confirm (`pending() === "acknowledge"`) before dispatch, since an indeterminate Command Attempt may
  repeat effects (story 39) — the full risk shows in the panel's recovery evidence, the rail prompt leads with the action so it never clips.
