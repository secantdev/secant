# store — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- `run.db` is the only canonical truth. `coordination.db` holds cross-Run facts (registration, the one-live-Run claim, owner fencing, create/delete
  admission) and is rebuildable: a corrupt one is deleted and re-seeded from the readable Run Stores with no owner and no claim, so never store truth
  there that a Run Store cannot reconstruct.
- Create publishes by renaming the `.creating` quarantine into place as the last step before the transaction commits; delete drops the registration first,
  then reclaims the directory. Any failure before those points leaves only a quarantine (or an unadopted directory) the next open removes. The one window
  left is process death between a successful rename and the commit — the same accepted micro-window the Catalog carries.
- Destructive at open: when the coordination DB is intact (not rebuilt) it is authoritative, so any Run directory the `runs` registrations do not list is
  treated as a crash orphan and `rmSync`'d recursively (`openRunGroup`). A slice that stages a Run directory outside `admitCreate`'s committed transaction
  therefore loses it on the next open with no trace — the only safe way to add one is the `.creating` quarantine rename inside that transaction.
- The one-live-Run claim is enforced twice: the admit transaction checks under `BEGIN IMMEDIATE`, and a partial unique index on `state = 'live'` makes the
  database itself reject a second claim. Both matter — the index is the backstop the Windows `bun:sqlite` transaction path is trusted against.
- Owner fencing is a monotonic `owner_epoch` bumped on every `acquireRun`; a canonical write re-checks the epoch, so a stale owner (a returned crashed
  process) is refused. Ending a Run releases only the claim; its store stays until an explicit delete.
- Every `run.db` handle a Run Store opens is closed before its directory is renamed or the group closes, so Windows temp cleanup is never blocked by a lock.
- Artifact publication (#80) is all-or-nothing: the private Artifact Module stages one Git commit (its id is the version id) into `artifacts.git`, then one
  `run.db` transaction records the versions, moves the bindings, and settles the Attempt. A staged commit or ref alone is invisible candidate storage — only
  that transaction publishes — so a fault between the commit and the transaction leaves no binding moved, and republishing the same attempt id is a no-op.
- Git mechanics shell out to the `git` executable (no library); `artifacts.git` is created lazily on first publication. An absent `git` surfaces as a
  precise `git-unavailable` Problem only on the stage/publish path; the read path deliberately throws `GitUnavailable` (an environment fault is not an
  absent artifact) and `readArtifact` passes it through. Bindings/attempt reads validate their row at the read ingress like the coordination reads (D7).
- Startup reconciliation (#86): a live Workspace claim found at open is stale (a clean exit releases it via `endRun`), so its Run is rested `halted` with one
  appended `indeterminate` attempt-log marker and the claim released — running no Step work. The claim, not the stored state, distinguishes a killed Run from a
  derived-`blocked` Run (also stored `running` but with its claim released). The marker lands in `attempt_log` (not as an `attempt` row); the resume skip
  cursor reads that log, so it is the marker's `indeterminate` outcome — not any absence from the log — that keeps the succeeded-attempt cursor unchanged
  and re-runs the interrupted Step. Assumes one process per home; a PID/lock probe on the claim would be needed for concurrent processes.
- Reconciliation's one accepted micro-window: reaching a derived-`blocked` rest and releasing the claim is not atomic (execution returns `blocked`, then the
  caller's `finally` runs `endRun`), so a kill in that synchronous gap leaves the Run `running` with a live claim and reconciliation mislabels it `halted` — a
  resume then runs a fresh interval instead of an answer. Narrow, no data loss, same class as the create rename/commit window; persist a rested marker if it bites.
- A Human Gate answer (#85) is a bound Artifact recorded through `recordGateAnswer` — a publication-shaped write (stage a commit, then one transaction moves the
  binding and appends the `gate_answer` row) that deliberately skips `attempt_log`, so `blocked` stays derived and iterations still count off the log. Idempotent
  per `operation_id` (a UNIQUE column); its `iterations_at_grant` is the offset the derived "iterations since the last grant" count resets from.
