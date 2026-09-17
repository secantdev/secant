# application — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- Every canonical write to a Run must go through `observedOwner`, not the raw `RunOwner`, or an open client's live `run` Projection never updates.
  `observedOwner` spreads `...owner` and intercepts only five methods — `writeState`, `publishAttempt`, `recordMaterializationConflict`,
  `recordGateAnswer`, and `recordPendingGate` (the authored gate, #108, which rests the Run `blocked` in its own transaction) — pushing a fresh snapshot
  after each commits. A new `RunOwner` write method compiles and silently pushes nothing (A3).
- `answer-human-gate` serves two gate mechanisms off one Port operation (#108). The Projection derivation decides which: `derived.pendingGate` present is an
  **authored** gate, answered by settling its producing Attempt through `observedOwner.publishAttempt` (into `attempt_log`, so the resumed walk skips the gate) —
  `free-text` publishes the `text` answer as the gate's declared output and re-drives execution in this process, approve advances `running` and re-drives, reject
  settles `failed` and rests. Otherwise `derived.checkpoint` is a **derived Review checkpoint**, answered by `recordGateAnswer` exactly as M2 did (no `attempt_log`,
  `blocked` stays derived). The live Gate is `derived.pendingGate?.gate ?? derived.checkpoint?.gate` (a blocked Run has exactly one), and the answer form must match
  `gate.shape` (`free-text` ⇒ `text`, `approve-reject` ⇒ `continue`/`stop`) or it is a `gate-shape-mismatch` Problem that changes nothing. Idempotency is keyed on the
  operation id (`gate_answer` row for a checkpoint; the in-process operations map for both) — never on whether the gate settled, so a _different_ operation answering an
  already-answered gate falls through to the staleness check and is refused, not silently masked as `applied`.
- The Trust grant is written only after `createRun` succeeds: any refusal reached before creation (a mismatching trust acknowledgement, a failed
  Preflight) returns without a grant, so it never leaves a dangling one. (`createRun` itself no longer refuses — ADR 0031 admits any number of live
  Runs.) Preflight runs before the Trust gate, so a Run whose preconditions fail is refused before trust is ever asked for.
- Never `acquireRun` a Run merely to read it when it is live in another process: acquiring bumps the owner-fencing epoch and would abort the process
  running it. `readResource`/`runResult` read through the live in-process owner when present, else acquire-and-close a rested Run, else refuse with
  `run-live-elsewhere`.
- Execution stores `blocked` before returning a checkpoint pause, and the Application keeps that Run's owner open. The Projection still derives the checkpoint
  facts from the Attempt log, Verdict binding, and Gate answers; the stored state lets dead-owner reconciliation preserve the pending checkpoint.
- The timeline is ordered by `at` (`buildTimeline`), category as the tiebreak for equal instants (A2, #98): events are still built category by category, then sorted,
  so a later Attempt never moves an earlier event. ISO 8601 sorts lexicographically, so the string compare is the time compare.
- When the Attempt log ends on a passing Repeat Verdict, projection advances beyond the group before inspecting the next node. An authored Human Gate already has a
  durable `pending_gate` then but deliberately has no Attempt-log entry until answered; parking on the deciding Command would hide the gate and its answer Offer.
- Run settlement is deferred (#98 S1): `runAndSettle`/the answer-continue branch start the execution promise and `submit` returns `admitted` synchronously; the
  `finally` releases the owner only after a resting outcome and settlement publishes after it. A `blocked` Run keeps its owner with no execution promise until answered.
  One `AbortController` per live Run lives in the `runs` map. The Application never imports the
  execution `RunCancelledError`: it aborts its own controller, so `tracking.abort.signal.aborted` in the catch is exactly "our cancel/signal fired", and the reason
  (`CANCEL_ABORT` vs `SIGNAL_ABORT`) decides the rest — a cancel writes `cancelled` through the held owner, a signal leaves the claim live for the next open to reconcile.
- `cancel-run` is cancel-as-abort only for a Run live in THIS process (abort, await the promise, then delete the tracking entry); a Run live elsewhere still takes the
  fresh-owner epoch-bump path, which is why that path stays synchronous while the in-process path returns a Promise. `shutdown()` is the signal path: it aborts every live
  Run with `SIGNAL_ABORT` and awaits, leaving each ownership record live for startup reconciliation.
- `interrupt-turn`/`steer-turn` (#118) reach a live Agent Turn through the same one `AbortController`: `interrupt-turn` aborts it with `INTERRUPT_TURN_ABORT`, which the
  execution Module (owner of the reason strings, imported from there) translates into `turn.interrupt()` at the Harness Seam. All three reasons stop the live Turn; the reason
  decides the rest — `INTERRUPT_TURN_ABORT` and `SIGNAL_ABORT` map the interrupted/lost Turn to a `cancelled`/`indeterminate` Attempt that rests the Run `halted` in-process
  (no `RunCancelledError` thrown, so `runAndSettle` returns through its normal path), while `RUN_CANCEL_ABORT` throws `RunCancelledError` so cancel-run writes `cancelled`.
  Both `interrupt-turn` and `steer-turn` are offered only while a live (unsettled) Turn exists in this process; a control naming a settled Turn is rejected as a value, and
  `steer-turn` is always rejected (Claude Code has no same-Turn steer). `resume-run` continues a `detached` Session in the same Claude Code Session because the executor reads
  the stored Session availability and passes its coordinate as `resume`; a Session recorded `unusable` fails the Attempt without ever opening a fresh Session (ADR 0022).
  The one `AbortController` per Run means the three reasons race: a `cancel-run` and an `interrupt-turn` submitted concurrently for the same live Run both `abort()` it, and
  whichever fires first sets the reason the executor reads, so the loser's Operation still settles `applied` while the Run rests in the winner's state. This is the accepted
  extension of the pre-existing two-way (`CANCEL_ABORT` vs `SIGNAL_ABORT`) race — both callers intend to stop the Run, and the append-only Attempt log records what actually
  happened — not a new class of bug.
- A takeover that only re-owns a Run resting `blocked` settles synchronously in `runAndSettle` (it re-fences the owner, leaves the Run blocked, runs no execution). `startRun`
  must NOT set `tracking.promise` for it — the `promise === undefined` predicate is exactly what makes cancel/shutdown write the rest and release the owner rather than abort a
  dead signal and leave the Run stuck blocked with a leaked owner. The gate is `tracking.takeover === true && tracking.state === "blocked"`, captured before `runAndSettle`.
- `liveElsewhere` (a Run live in another process, owner pid alive) is refused before resume/answer claim anything (`run-live-elsewhere`, owner named), and `readResource`
  refuses it too; `listRuns` throwing on a malformed row is caught in cancel/delete so nothing throws out of `submit` (A4).
- The client `RunStateName` has no `created` and gains `cancelled` (A7); the Run Store still records `created` internally, and `toRunState` maps it to `running` for the
  Projection — a launched Run reads `running` from admission.
- The prepared Harness lives in composition, not the Application (#116): `makeRunExecution` (composition/wiring) prepares one when a routing carries an Agent Step, hands it to
  execution, and closes it when the Run rests (ownership transferred exactly once, ADR 0022). Preflight does the _synchronous_ Harness discovery (configured command then the
  `claude` PATH name, via the `process` resolver) and the capability-need union, so a `not-found`/`unsupported-shim`/`interactive-step-needs-tui` refusal lands before a Run
  exists; the async `prepare` (spawning `claude --version`) runs only at execution. `supportsInteractiveTurns` is a client fact the Application forwards to Preflight.
- The Agent executor's Turn writes (`admitTurn`/`appendTurnEvent`/`settleTurn`) go through the raw owner (not intercepted by `observedOwner`), so they push no live snapshot;
  the Turn's durable timeline, Session availability, and effective model surface on the next intercepted write (the Attempt's `publishAttempt`).
- The Agent executor records the normalized Harness identity (name/executable/version) on that Attempt from the prepared profile (#125), so the `run`
  Projection reads it back through `owner.harnessIdentity()` and exposes it as the additive `run.harness` view — one identity for the latest Agent-step
  Attempt, no native id crossing the Port; absent for a Command-only Run.
- `send-interactive-turn`/`end-interactive-step` (#122) drive an interactive-agent Step the Run rests `blocked` at. The executor records **no** durable gate — the block is
  derived from the current Step being `interactive-agent` (the same signal the TUI blocked-basis reads), and no Attempt settles until End. `beginInteractive` reuses the held
  owner (a blocked Run keeps it) or resumes+acquires a reopened one, then re-derives to confirm the Run is blocked at the named Step. `send` drives one human Turn (origin
  `human`, verbatim text as the transcript input) through the `runInteractiveTurn` seam against that owner and stays `blocked` between Turns (owner held, no execution promise,
  ADR 0031); the Turn's writes bypass `observedOwner`, so it `pushRunUpdate`s the new transcript itself. `end` publishes the Step's derived Attempt
  (`interactiveStepAttemptId`, an empty succeeded Attempt that stages no commit) with `advanceState: "running"` and re-drives execution, which skips the settled Step and
  reuses its Session. Both set `tracking.promise` (via a `start*` helper) so cancel-run/interrupt-turn find and abort a live human Turn; the abort reason decides the rest as
  the answer path does. `send` is refused blank at admission (before any stdin); `end` mid-Turn (a live Turn) is refused as a value.
- `deriveRun`'s walk assumes `attempt_log` holds only per-Step Attempts, but the Run Store already appends the reconciliation `indeterminate` marker row
  there (see `store/AGENTS.md`). The marker is harmless only because its outcome is not `succeeded`, not because the walk excludes it — keep that true if
  you add marker rows.
