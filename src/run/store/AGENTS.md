# store — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- `run.db` is the only canonical truth and owns its Run's nullable process id plus monotonic fencing epoch. `coordination.db` holds only registration and
  create/delete admission and is rebuildable: a corrupt one is deleted and re-seeded from readable Run Stores without changing their owner records.
- `run_record.selected_harness` is the immutable semantic Run selection, written in the staged store before create publishes. It is nullable only for
  Command-only and pre-M4 Runs, validates as closed `claude-code | codex` at read ingress, and stays distinct from per-Attempt Harness/model evidence (#138, #146).
  `RunOwner.selectHarness` is the sole legacy upgrade write: fenced, null-only, and idempotent when the same immutable id is already present (#139).
- `run_record.requested_model` is the immutable model requested at launch (#187), written with `selected_harness` in the staged store before create publishes and never
  changed after. It is free text (no closed-set validation at the read ingress, unlike `selected_harness`), null when the launch requested no model — the Harness default
  applies, never a substituted value — and for a Command-only Run. Composition threads it into `prepare` identically on launch and resume; it stays distinct from the
  per-Attempt observed `effective_model`.
- Ownership is per Run, not per Workspace (ADR 0031): each Run Store carries one owner record; an absent record reads unowned at epoch zero. There is no
  Workspace-wide claim column and no one-live-Run index, so any number of Runs may be live in one Workspace at once, each owned separately.
  `createRun` never refuses for the Workspace and two concurrent creates both succeed; ownership is set on the create/resume claim and released only on
  rest/delete/takeover — including _held through_ derived-`blocked`, so a Review checkpoint is answered in the instance that reached it.
- Create publishes by renaming the `.creating` quarantine into place as the last step before the transaction commits; delete drops the registration first,
  then reclaims the directory. Any failure before those points leaves only a quarantine (or an unadopted directory) the next open removes. The one window
  left is process death between a successful rename and the commit — the same accepted micro-window the Catalog carries.
- Coordination open retries migration once before corruption recovery: concurrent migrators may both read a stale journal, then the loser must reopen and
  observe the winner's committed generated ALTER rather than deleting the healthy database underneath it. Only `SQLITE_CORRUPT`/`SQLITE_NOTADB` enters
  destructive rebuild; permission, I/O, lock, and other failures propagate with their cause.
- Destructive at open: when the coordination DB is intact (not rebuilt) it is authoritative, so any Run directory the `runs` registrations do not list is
  treated as a crash orphan and `rmSync`'d recursively (`openRunGroup`). A slice that stages a Run directory outside `admitCreate`'s committed transaction
  therefore loses it on the next open with no trace — the only safe way to add one is the `.creating` quarantine rename inside that transaction.
- Owner fencing is a monotonic epoch bumped on every `acquireRun`. Every canonical write opens one immediate `run.db` transaction, reads the epoch first,
  refuses a stale owner without writing, and otherwise performs the whole write in that transaction; private writers take that transaction and never open
  another. `publishAttempt` and `recordGateAnswer` keep a cheap check before staging Git but repeat the authoritative check inside the write transaction.
  `acquireRun` bumps the epoch without claiming, so a Projection read never marks a resting Run live. Only takeover claims this process while bumping;
  `endRun` releases only this process's ownership and leaves the store until explicit deletion.
- Takeover is what makes ownership safe, not the probe (ADR 0031): a plain `acquireRun`/`resumeRun` declines a Run owned by a live _other_ process (the
  courtesy probe, `process.kill(pid, 0)`), so the Application can confirm before fencing; the `takeover` flag bumps the epoch anyway, so the previous owner's
  next canonical write is refused. `resumeRun` refuses such a Run `run-live-elsewhere` with its `ownerPid`; a takeover is
  `acquireRun({ takeover: true })`.
- Every `run.db` handle a Run Store opens is closed before its directory is renamed or the group closes, so Windows temp cleanup is never blocked by a lock.
- Artifact publication (#80) is all-or-nothing: the private Artifact Module stages one Git commit (its id is the version id) into `artifacts.git`, then one
  `run.db` transaction records the versions, moves the bindings, and settles the Attempt. A staged commit or ref alone is invisible candidate storage — only
  that transaction publishes — so a fault between the commit and the transaction leaves no binding moved, and republishing the same attempt id is a no-op.
- Git mechanics shell out to the `git` executable (no library); `artifacts.git` is created lazily on first publication. An absent `git` surfaces as a
  precise `git-unavailable` Problem only on the stage/publish path; the read path deliberately throws `GitUnavailable` (an environment fault is not an
  absent artifact) and `readArtifact` passes it through. Bindings/attempt reads validate their row at the read ingress like the coordination reads (D7).
- Startup reconciliation (#86, #98 S2, ADR 0031): at open every registration opens its `run.db`, reads the owner, probes it, and performs any rest plus
  release inside that same immediate transaction (`process.kill(pid, 0)` is injectable as `isOwnerAlive`). An owner still alive in another process is a
  Run genuinely live there — left untouched, listed with its `ownerPid` so the Application can refuse `run-live-elsewhere`. A dead owner is reconciled
  **by stored state**: a `running`/`created` record is rested `halted` with one appended
  `indeterminate` attempt-log marker; every other state is already at rest and left as-is, so a `blocked` record stays `blocked` (nothing was cut off, the
  checkpoint still holds). Either way its ownership is released, running no Step work. The `pid !== selfPid` guard makes an owner equal to our own pid always
  reconcile — this handles pid reuse and lets a same-process reopen (the reconciliation tests) reconcile; `selfPid` is injectable so two `openRunGroup`s on one
  home stand in for two processes. Previous-release databases migrate through the embedded Drizzle journals at open. The marker lands in `attempt_log`
  (not an `attempt` row); the resume skip cursor reads that log, so it is the marker's
  `indeterminate` outcome — not any absence from the log — that keeps the succeeded-attempt cursor unchanged and re-runs the interrupted Step.
- An acquired owner releases through its fencing epoch. A stale owner whose Run was taken over cannot clear the new owner during its own cleanup.
- Diagnostics retention (ADR 0023, #96): `diagnostics/` has had a writer since #88, so the 90-day expiry is a best-effort prune at group open (`pruneDiagnostics`,
  driven by an injectable clock) — files with an mtime at or before `now - 90 days` are deleted, newer ones kept. It walks Run directories on the filesystem, not
  the registrations, so it runs before any Run is acquired and never fails the open.
- D7 has two halves. The closed-set columns the Store itself branches on — `attempt_log.outcome`, `gate_answer.answer`, and `pending_gate.shape` — are validated with `z.enum`
  at their read ingress (not cast), so a drifted value is rejected there rather than trusted by the resume cursor, the grant count, or the pending-gate derivation. The six M3
  closed-set columns the Store does **not** branch on — turn `origin`, turn `kind`, turn `result_kind`, `turn_event.kind`, `harness_session.availability`, and
  `transcript_entry.role` — are returned raw and narrowed tolerantly at the Projection's read ingress instead (an unknown value falls to a safe default), so the Store never
  rejects a Turn row over a value only the client interprets.
- A Human Gate answer (#85) is a bound Artifact recorded through `recordGateAnswer` — a publication-shaped write (stage a commit, then one transaction moves the
  binding and appends the `gate_answer` row) that deliberately skips `attempt_log`, so `blocked` stays derived and iterations still count off the log. Idempotent
  per `operation_id` (a UNIQUE column); its `iterations_at_grant` is the offset the derived "iterations since the last grant" count resets from.
- An **authored** Human Gate (#108) is a different mechanism from the derived Review checkpoint above. `recordPendingGate` writes a durable `pending_gate` row (keyed on
  the producing Attempt id) **and rests the Run `blocked` in the same transaction**, so a crash cannot leave the record without the pause; it is idempotent on the Attempt
  id (`onConflictDoNothing`), so a resume that re-reaches the gate re-records nothing. The gate is "pending" only until that Attempt settles: `pendingGate()` returns the
  row whose Attempt id is not yet in `attempts` (the Projection derives the authored gate from it, distinct from a derived checkpoint).
  Unlike the derived checkpoint, the authored gate is answered by **settling its Attempt through `publishAttempt`** (into `attempt_log`, so resume skips the gate):
  `free-text` publishes the `text` answer as the declared output and advances `running`; approve settles succeeded with no output; reject settles failed and rests
  `failed`.
- `publishAttempt` for a **succeeded Attempt with no outputs and no required outputs** stages no commit (an empty tree is not valid `git mktree` input) and settles with
  no version — the approve-reject authored-gate answer (#108) and every Agent-step Attempt (#116, which produces no Artifacts). Every other succeeded Attempt produces at
  least one output and stages a commit as before.
- Harness Turn records (#116): `admitTurn` writes the `turn` row **before** the stdin frame is sent (the durable admission the Adapter awaits) — it upserts the named Session
  `open` and the rendered input as a `user` transcript entry in one transaction, and a fenced owner refuses it, proving the Turn `not-started` so no stdin is sent.
- `settleTurn` is immutable: it no-ops once the `turn` row's `result_kind` is set, so a second settle rewrites neither the result nor the Session availability. `turn_event`s
  append only. The Attempt's `effective_model` is set through `publishAttempt` (the `attempt` row is written after the Turn settles), never through `settleTurn`.
- Turn `kind` (#126): `admitTurn` records the Crucible Step kind that produced the Turn — `agent` or `interactive-agent` — in the nullable `turn.kind` column, Crucible-owned
  durable truth independent of `origin` (`managed`/`human`). The column is nullable so a row admitted before it existed reads its kind back **null** (undefined in
  `TurnRecord`) — a legacy row whose kind is genuinely unknown, never fabricated to a guess.
- The `attempt` row also carries the normalized Harness identity and steer evidence of an Agent-step Attempt (#125, #134):
  `harness`/`executable`/`executable_version` plus `steer_available`/`steer_evidence`, written together by `publishAttempt` from the prepared profile (all null for a
  Command/Gate Attempt). The `PublishAttemptRequest` union permits an identity plus optional model or neither, never a new model-only row. `harnessEvidence()` reads both
  facts from the one latest Agent-evidence row, so a model-less resumed Attempt clears the projected model rather than inheriting an older value. A non-null model still
  admits an explicit legacy model-only row written before identity existed. Identity is recorded on every autonomous Agent Step outcome, including
  `cancelled`/`indeterminate` and recovery refusal; the interactive-agent Step's synthetic Attempt (#122) records neither, so a purely-interactive Run projects none (#147).
- Transcript ordering (#124): `transcript_entry.seq` is an `INTEGER PRIMARY KEY`, i.e. an alias for the database-wide rowid, so it is monotonic across the whole `run.db`, not
  per Session; a page filters it by Session key and pages upward by `seq` (`before`). The rowid alias is exactly why a page cursor stays stable — appending later rows never
  renumbers earlier ones — so an opaque `before` cursor keeps naming the same boundary.
- Turn ordering (#116): `turn.sequence` is `count(turn)` taken under the admit transaction, so it numbers every Turn in the Run regardless of Session — two Sessions' Turns
  interleave in one numbering, and it is not a per-Session sequence.
- `turn_event.payload` is opaque JSON, never a raw protocol frame: the Store neither validates nor interprets it, and the Projection reads it tolerantly (an unrecognized event
  kind projects nothing). Only Crucible-shaped normalized events are ever written.
- There are no foreign keys and no `foreign_keys` pragma anywhere in either schema (only `busy_timeout` is set), so referential integrity rests entirely on the write
  transactions that keep related rows consistent; nothing the database enforces stands behind them.
- Run delete drops the registration and reclaims the directory as one lifecycle unit; with no foreign keys there is nothing to cascade — the directory holds the whole Run.
- Resume reads registration only to answer `unknown-run`, then claims ownership in `run.db`. Listing and startup reconciliation open each registered Run
  Store to read ownership and close every handle before returning; a damaged store lists unowned, matching its exact-read Problem. A coordinator rebuild
  reads each readable Run's owner before restoring registration, so a live owner survives corruption and the following reconciliation decides its fate.

## Tests

- Store Interface tests are split by concern into `ownership-and-recovery.test.ts`, `attempt-and-artifact-publication.test.ts`,
  `session-and-transcript-evidence.test.ts`, `materialization.test.ts`, and `reconcile-turn.test.ts`; keep every file independently runnable with explicit fixtures.
