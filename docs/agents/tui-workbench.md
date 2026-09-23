# Run Workbench Interaction

Read this before changing the Run Workbench's key routing, modal stack, steer compose, interactive input, destructive confirms, or details panel. It was
carved out of [the presentation Module's notes](../../src/tui/AGENTS.md), which keep the general OpenTUI layout invariants and the rule that the Workbench
alone takes its keys, size, and resize from the Renderer Port; the Application side of the controls it dispatches is in [run-control](./run-control.md).

## Key routing and native inputs

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
- The interactive-agent input (`run-workbench.tsx`, #122) is a native OpenTUI `<input>` (D9): while `focus` is `interactive` the field owns text, so `q`/`r`/`c`/`x`/`t`
  type into it rather than fire their bare-letter commands (only Ctrl+C still exits, and the dispatcher gates those commands on not typing). The field carries capitals,
  punctuation, paste and word delete verbatim. Enter dispatches `send-interactive-turn` (blank/whitespace refused before dispatch, and a refused send keeps the draft, A9);
  Ctrl+E arms `end-interactive-step`, offered — and so armable — only at a Turn boundary (no live Turn), reusing the same `pending` arm-and-confirm. The Step is "active"
  whenever the Run is blocked at an `interactive-agent` Step (independent of a live Turn), so focus stays on the input across the whole Step and returns to the timeline when
  it ends.
- Typed-but-unsent interactive text (the `draft` signal) clears only on a **fresh** interactive Step (the focus effect keyed on the Step id), so it survives a
  Turn settle and a tab away within the same Step; a send clears it optimistically before dispatch, so a refused send loses the text (the refusal re-surfaces,
  the draft does not).

## Modal stack and composes

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
- A stale approval answer keeps its inline refusal while the offer re-renders: a genuinely new request (a fresh `requestId`) resets the decision to `allow`
  and clears the refusal, but a stale answer keeps the same id, so its refusal survives while the bumped-generation offer re-renders (`onIdentityChange` on
  the request id).

## Run Actions, details panel, and live updates

- A destructive Run Action (cancel or delete) arms a confirming keypress before it dispatches (`run-workbench.tsx` `pending`): `y` confirms, Escape backs out.
  An ordinary resume dispatches at once; a resume Offer carrying a takeover form first confirms once and names the foreign owner process.
- `ResumeRunOffer` is a `SteerTurnOffer`-style union (#194): `available:false` renders `resume — unavailable · <reason>` and `r` no-ops (story 40); an
  `available:true` offer with `acknowledgement` arms an extra confirm (`pending() === "acknowledge"`) before dispatch, since an indeterminate Command Attempt may
  repeat effects (story 39) — the full risk shows in the panel's recovery evidence, the rail prompt leads with the action so it never clips.
- The Harness/model facts (#125/#147), recovery evidence, the story-38 resting reason, and cancel/delete moved off the header/rail into the details panel (#194).
  `buildDetailsRows` (`run-workbench-views.tsx`) builds the panel once; the container reserves exactly `detailsRows().length` rows, so render and row accounting
  never drift. Recovery lines appear only when their Run-view fact is present. `c`/`x` act only while the panel is shown, confirm in the panel; the rail keeps only
  resume and the live-Turn interrupt/steer. A terminal/`halted` rest also shows one `restingProse` line beside the header state word (colour is never the only
  signal); `blocked` keeps that prose only in the panel, and `headerRows()` counts it.
- A live update is told from a durable one by kind, and the settling watermark drives the preview-to-authoritative swap (`reduceRunUpdate`, `run-view.tsx`):
  a `live` overlay at phase `settling` records the durable `settledCountAtSettling`; the next `durable` update whose settled-Turn count passes it drops the
  live overlay and preview and shows the authoritative snapshot alone. A `preview` update only refreshes the streaming text.

## Tests

- Interactive and steer input text rides `testRender`'s mock input (the field's real key source) while the dispatcher's command keys ride the fake Renderer Port.

## Read next

- `run-inspection.tsx` holds the Workbench's reference-inspection overlay — its state, key loop, and view — split out of `run-workbench.tsx` (A26).
  `run-workbench-views.tsx` holds the Workbench's four pure presentational leaves; state, focus, modal precedence, and the key dispatcher stay in
  `run-workbench.tsx` (A12).
