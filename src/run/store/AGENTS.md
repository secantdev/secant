# store — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- `run.db` is the only canonical truth. `coordination.db` holds cross-Run facts (registration, the one-live-Run claim, owner fencing, create/delete
  admission) and is rebuildable: a corrupt one is deleted and re-seeded from the readable Run Stores with no owner and no claim, so never store truth
  there that a Run Store cannot reconstruct.
- Create publishes by renaming the `.creating` quarantine into place as the last step before the transaction commits; delete drops the registration first,
  then reclaims the directory. Any failure before those points leaves only a quarantine (or an unadopted directory) the next open removes. The one window
  left is process death between a successful rename and the commit — the same accepted micro-window the Catalog carries.
- The one-live-Run claim is enforced twice: the admit transaction checks under `BEGIN IMMEDIATE`, and a partial unique index on `state = 'live'` makes the
  database itself reject a second claim. Both matter — the index is the backstop the Windows `bun:sqlite` transaction path is trusted against.
- Owner fencing is a monotonic `owner_epoch` bumped on every `acquireRun`; a canonical write re-checks the epoch, so a stale owner (a returned crashed
  process) is refused. Ending a Run releases only the claim; its store stays until an explicit delete.
- Every `run.db` handle a Run Store opens is closed before its directory is renamed or the group closes, so Windows temp cleanup is never blocked by a lock.
- Artifact publication (#80) is all-or-nothing: the private Artifact Module stages one Git commit (its id is the version id) into `artifacts.git`, then one
  `run.db` transaction records the versions, moves the bindings, and settles the Attempt. A staged commit or ref alone is invisible candidate storage — only
  that transaction publishes — so a fault between the commit and the transaction leaves no binding moved, and republishing the same attempt id is a no-op.
- Git mechanics shell out to the `git` executable (no library); `artifacts.git` is created lazily on first publication, and an absent `git` is a precise
  `git-unavailable` Problem, not a throw. Bindings/attempt reads validate their row at the read ingress like the coordination reads (D7).
