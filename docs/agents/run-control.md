# Live Run Control

Read this before changing live Run control in the Application: deferred settlement, cancel and shutdown, Turn interrupt and steer, takeover, the
interactive-Step drive, or the live overlay. It was carved out of [the Application Module's notes](../../src/application/AGENTS.md), which keep the
write, launch, and read invariants; the abort-reason vocabulary and the resting state each reason maps to are owned by
[the Run execution Module's notes](../../src/run/execution/AGENTS.md).

## Settlement, cancel, and shutdown

- Run settlement is deferred (#98 S1): `runAndSettle`/the answer-continue branch start the execution promise and `submit` returns `admitted` synchronously; the
  `finally` releases the owner only after a resting outcome and settlement publishes after it. A `blocked` Run keeps its owner with no execution promise until answered.
- One `AbortController` per live Run lives in the `runs` map. The Application never imports the execution `RunCancelledError`: it aborts its own controller, so
  `tracking.abort.signal.aborted` in the catch is exactly "our cancel/signal fired", and the reason decides the rest — `RUN_CANCEL_ABORT` throws `RunCancelledError`
  so cancel-run writes `cancelled` through the held owner; `INTERRUPT_TURN_ABORT` and `SIGNAL_ABORT` throw nothing, so `runAndSettle` returns through its normal
  path and a signal leaves the claim live for the next open to reconcile.
- `cancel-run` is cancel-as-abort for active work in this process; a held blocked Run is rested directly, a non-live blocked Run is acquired and rested, and a Run live
  elsewhere takes the fresh-owner epoch-bump path. `shutdown()` has two phases: close and release blocked Runs without changing their state, then abort and await running
  work with `SIGNAL_ABORT`, leaving those ownership records live for startup reconciliation.
- The one `AbortController` per Run means the three reasons race: a `cancel-run` and an `interrupt-turn` submitted concurrently for the same live Run both `abort()` it,
  and whichever fires first sets the reason the executor reads, so the loser's Operation still settles `applied` while the Run rests in the winner's state. This is the
  accepted extension of the two-way cancel-versus-signal race — both callers intend to stop the Run, and the append-only Attempt log records what actually happened — not
  a new class of bug.

## Turn interrupt and steer

- `interrupt-turn` (#118) reaches a live Agent Turn through the same one `AbortController`, aborting it with `INTERRUPT_TURN_ABORT` (imported from execution, which
  translates it into `turn.interrupt()` at the Harness Seam).
- Both `interrupt-turn` and `steer-turn` are offered only while a live (unsettled) Turn exists in this process; a control naming a settled Turn is rejected as a value.
- The steer Offer is discriminated on the prepared profile's steer evidence (live first, then persisted with the Attempt), never Adapter prose above the Seam: a Harness
  with native steer (Codex) offers it `available` with the live turnId, one without (Claude Code) offers it `available:false` with the evidence as `reason` (#148).
- Unlike interrupt, steer does **not** use the AbortController — it keeps the Turn working. `submitSteerTurn` refuses an unavailable profile with `steer-unavailable`
  before any native call, else reaches the live Turn's `tracking.live.steer` (bound by `driveHarnessTurn` over `turn.steer` via the `RequestChannel.bindSteer` hook,
  unbound at Turn end alongside `bindAnswer`); a native control race settles `steer-rejected`, a stale/settled turnId `turn-control-rejected`, an accepted steer
  `applied`, Run still running.
- `resume-run` continues a `detached` Session in the same native Session because the executor reads the stored Session availability and passes its coordinate as
  `resume`; a Session recorded `unusable` fails the Attempt without ever opening a fresh Session (ADR 0022).

## Takeover

- A takeover that only re-owns a Run resting `blocked` settles synchronously in `runAndSettle` (it re-fences the owner, leaves the Run blocked, runs no execution).
  `startRun` must NOT set `tracking.promise` for it — the `promise === undefined` predicate is exactly what makes cancel/shutdown write the rest and release the owner
  rather than abort a dead signal and leave the Run stuck blocked with a leaked owner. The gate is `tracking.takeover === true && tracking.state === "blocked"`,
  captured before `runAndSettle`.

## Interactive-Step drive

- `send-interactive-turn`/`end-interactive-step` (#122) drive an interactive-agent Step the Run rests `blocked` at. The executor records **no** durable gate — the block
  is derived from the current Step being `interactive-agent` (the same signal the TUI blocked-basis reads), and no Attempt settles until End.
- `beginInteractive` reuses the held owner (a blocked Run keeps it) or resumes+acquires a reopened one, then re-derives to confirm the Run is blocked at the named Step.
- `send` drives one human Turn (origin `human`, verbatim text as the transcript input) through the opaque Step driver against that owner and stays `blocked` between
  Turns (owner held, no execution promise, ADR 0031); the Turn's writes bypass `observedOwner`, so it `pushRunUpdate`s the new transcript itself.
- `interactiveStepTarget` derives the resting iteration's Attempt id and Session from the attempt log (a Step inside a Repeat group, or `fresh`, gets a
  per-Attempt Session). `end` publishes that Attempt (empty, succeeded, stages no commit) with `advanceState: "running"` and re-drives execution, which
  re-walks from the top, replays settled iterations, and skips the settled Step (#216).
- Both set `tracking.promise` (via a `start*` helper) so cancel-run/interrupt-turn find and abort a live human Turn; the abort reason decides the rest as the answer path
  does. `send` is refused blank at admission (before any stdin); `end` mid-Turn (a live Turn) is refused as a value.
- `continue-repeat` (#217) is `end` for a Step inside a human-controlled Repeat, which the scheduler re-walks into the next iteration; the Projection offers it
  in End Step's place. Each control is refused as a value on the other's Step (`inHumanRepeat`), so one iteration is never settled by both.

## Live overlay

- The private `live-overlay.ts` channel carries a `generation` that a raised or settled request bumps, each pushing a fresh overlay, so an answer formed against a
  superseded generation is refused as stale. A `preview`-only observation is a coalesced update that deliberately does **not** bump the generation, so an in-flight
  answer stays valid across it (#117).
- At Turn end `bindAnswer(undefined)` clears any still-outstanding request, bumps the generation, and sets the live phase to `settling` before announcing the overlay, so
  a resumed Run starts clean. The durable `request-expired` timeline row is execution's write, not the live lane's.
- A **durable** push (`pushRunUpdate`) fans out to this Run's observers **and** every Run-list observer (`pushRunListUpdates`); a **live overlay** channel push reaches
  this Run's observers only.
- A late-joining observer catches up on the current overlay at open, so a follower connecting after a request was raised still sees it. By design a client can
  therefore receive live and preview updates for a Turn whose durable start it never saw: a headless follower opening mid-Turn observes the live request even though its
  durable Turn-start snapshot predates the connection.
- An approval Request's answer names its own source — `human` or `client-policy` (`HarnessAnswerSource`); the client declaring provenance is what lets the durable
  timeline render "answered by client policy" (`run-projection`) without the Adapter knowing a client policy exists.
