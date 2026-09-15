# store — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- `run.db` is the only canonical truth. `coordination.db` holds cross-Run facts (registration, per-Run ownership, owner fencing, create/delete
  admission) and is rebuildable: a corrupt one is deleted and re-seeded from the readable Run Stores unowned, so never store truth there that a Run
  Store cannot reconstruct.
- Ownership is per Run, not per Workspace (ADR 0031): the `runs` row carries the nullable `owner_pid` (`NULL` = unowned) beside the fencing epoch —
  there is no Workspace-wide claim column and no one-live-Run index, so any number of Runs may be live in one Workspace at once, each owned separately.
  `createRun` never refuses for the Workspace and two concurrent creates both succeed; ownership is set on the create/resume claim and released only on
  rest/delete/takeover — including _held through_ derived-`blocked`, so a Review checkpoint is answered in the instance that reached it.
- Create publishes by renaming the `.creating` quarantine into place as the last step before the transaction commits; delete drops the registration first,
  then reclaims the directory. Any failure before those points leaves only a quarantine (or an unadopted directory) the next open removes. The one window
  left is process death between a successful rename and the commit — the same accepted micro-window the Catalog carries.
- Destructive at open: when the coordination DB is intact (not rebuilt) it is authoritative, so any Run directory the `runs` registrations do not list is
  treated as a crash orphan and `rmSync`'d recursively (`openRunGroup`). A slice that stages a Run directory outside `admitCreate`'s committed transaction
  therefore loses it on the next open with no trace — the only safe way to add one is the `.creating` quarantine rename inside that transaction.
- Owner fencing is a monotonic `owner_epoch` bumped on every `acquireRun`; a canonical write re-checks the epoch, so a stale owner (a returned crashed
  process) is refused. `acquireRun` bumps the epoch but does **not** touch `owner_pid` — ownership is the create/resume claim, so a short-lived read-acquire
  (a Projection read, `readResource`) never marks a resting Run live. Only a takeover (`acquireRun` with `takeover`) claims `owner_pid` for this process and
  fences the previous owner regardless of the liveness probe; `endRun` releases ownership (clears `owner_pid`) and its store stays until an explicit delete.
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
- Startup reconciliation (#86, #98 S2, ADR 0031): at open every _owned_ Run (`owner_pid` not NULL) is bookkept by probing its owner (`process.kill(pid, 0)`,
  injectable as `isOwnerAlive`). An owner still alive in another process is a Run genuinely live there — left untouched, listed with its `ownerPid` so the
  Application can refuse `run-live-elsewhere`. A dead owner is reconciled **by stored state**: a `running`/`created` record is rested `halted` with one appended
  `indeterminate` attempt-log marker; every other state is already at rest and left as-is, so a `blocked` record stays `blocked` (nothing was cut off, the
  checkpoint still holds). Either way its ownership is released, running no Step work. The `pid !== selfPid` guard makes an owner equal to our own pid always
  reconcile — this handles pid reuse and lets a same-process reopen (the reconciliation tests) reconcile; `selfPid` is injectable so two `openRunGroup`s on one
  home stand in for two processes. The generated coordination schema models nullable `owner_pid` directly; previous-release databases migrate through the
  embedded Drizzle journal at open. The marker lands in `attempt_log` (not an `attempt` row); the resume skip cursor reads that log, so it is the marker's
  `indeterminate` outcome — not any absence from the log — that keeps the succeeded-attempt cursor unchanged and re-runs the interrupted Step.
- Reconciliation splits by stored state, so execution stores `blocked` before returning a checkpoint pause. A dead-owner open then keeps the pending checkpoint
  `blocked` and releases only its ownership; it never invents an interrupted Attempt.
- An acquired owner releases through its fencing epoch. A stale owner whose Run was taken over cannot clear the new owner's `owner_pid` during its own cleanup.
- Diagnostics retention (ADR 0023, #96): `diagnostics/` has had a writer since #88, so the 90-day expiry is a best-effort prune at group open (`pruneDiagnostics`,
  driven by an injectable clock) — files with an mtime at or before `now - 90 days` are deleted, newer ones kept. It walks Run directories on the filesystem, not
  the registrations, so it runs before any Run is acquired and never fails the open. The two enum columns domain logic branches on — `attempt_log.outcome` and
  `gate_answer.answer` — are validated with `z.enum` at their read ingress (not cast), so a drifted value is rejected there rather than trusted by the resume cursor
  or the grant count.
- A Human Gate answer (#85) is a bound Artifact recorded through `recordGateAnswer` — a publication-shaped write (stage a commit, then one transaction moves the
  binding and appends the `gate_answer` row) that deliberately skips `attempt_log`, so `blocked` stays derived and iterations still count off the log. Idempotent
  per `operation_id` (a UNIQUE column); its `iterations_at_grant` is the offset the derived "iterations since the last grant" count resets from.
