# application — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- Every canonical write to a Run must go through `observedOwner`, not the raw `RunOwner`, or an open client's live `run` Projection never updates.
  `observedOwner` spreads `...owner` and intercepts only four methods — `writeState`, `publishAttempt`, `recordMaterializationConflict`,
  `recordGateAnswer` — pushing a fresh snapshot after each commits. A new `RunOwner` write method compiles and silently pushes nothing (A3).
- The Trust grant is written only after `createRun` succeeds: a `workspace-busy` refusal returns before any grant, so a busy Workspace never leaves a
  dangling grant. Preflight runs before the Trust gate, so a Run whose preconditions fail is refused before trust is ever asked for.
- Never `acquireRun` a Run merely to read it when it is live in another process: acquiring bumps the owner-fencing epoch and would abort the process
  running it. `readResource`/`runResult` read through the live in-process owner when present, else acquire-and-close a rested Run, else refuse with
  `run-live-elsewhere`.
- `blocked` is never stored. The stored state stays `running` with its claim released; the Projection re-derives `blocked` from the current Step Attempt
  (`deriveRun`). Do not persist it.
- The timeline is ordered by `at` (`buildTimeline`), category as the tiebreak for equal instants (A2, #98): events are still built category by category, then sorted,
  so a later Attempt never moves an earlier event. ISO 8601 sorts lexicographically, so the string compare is the time compare.
- Run settlement is deferred (#98 S1): `runAndSettle`/the answer-continue branch start the execution promise and `submit` returns `admitted` synchronously; the
  `finally` releases the owner/claim and settlement publishes after it. One `AbortController` per live Run lives in the `runs` map. The Application never imports the
  execution `RunCancelledError`: it aborts its own controller, so `tracking.abort.signal.aborted` in the catch is exactly "our cancel/signal fired", and the reason
  (`CANCEL_ABORT` vs `SIGNAL_ABORT`) decides the rest — a cancel writes `cancelled` through the held owner, a signal leaves the claim live for the next open to reconcile.
- `cancel-run` is cancel-as-abort only for a Run live in THIS process (abort, await the promise, then delete the tracking entry); a Run live elsewhere still takes the
  fresh-owner epoch-bump path, which is why that path stays synchronous while the in-process path returns a Promise. `shutdown()` is the signal path: it aborts every live
  Run with `SIGNAL_ABORT` and awaits, leaving each claim live.
- `liveElsewhere` (a Run live in another process, owner pid alive) is refused before resume/answer claim anything (`run-live-elsewhere`, owner named), and `readResource`
  refuses it too; `listRuns` throwing on a malformed row is caught in cancel/delete so nothing throws out of `submit` (A4).
- The client `RunStateName` has no `created` and gains `cancelled` (A7); the Run Store still records `created` internally, and `toRunState` maps it to `running` for the
  Projection — a launched Run reads `running` from admission.
- `deriveRun`'s walk assumes `attempt_log` holds only per-Step Attempts, but the Run Store already appends the reconciliation `indeterminate` marker row
  there (see `store/AGENTS.md`). The marker is harmless only because its outcome is not `succeeded`, not because the walk excludes it — keep that true if
  you add marker rows.
