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
- The timeline is emitted by category, not by time (`buildTimeline`), until A2 sorts it by `at`; treat that ordering as provisional.
- `deriveRun`'s walk assumes `attempt_log` holds only per-Step Attempts, but the Run Store already appends the reconciliation `indeterminate` marker row
  there (see `store/AGENTS.md`). The marker is harmless only because its outcome is not `succeeded`, not because the walk excludes it — keep that true if
  you add marker rows.
