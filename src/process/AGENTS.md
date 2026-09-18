# process — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- `killGroup` is two-stage on every OS (#127 A6): the graceful signal is SIGTERM to the group off Windows and `taskkill /T` without `/F` on Windows — a
  close request to each window in the tree, which a windowless (hidden-console) child cannot observe and therefore survives; the forced signal is SIGKILL
  or `taskkill /T /F`. So on Windows a hidden console child always waits out the graceful bound and is then reported `escalated: true`. No child is
  known to stop in the graceful stage on the Windows CI runner (a shown WinForms window survived `taskkill /T`, run 35297175838), so the graceful-stop
  proof is a named gap there and only the escalation case runs on Windows.
- Interrupt and terminate are a two-stage shutdown that shares one `gracefulMs`: the process gets the whole bound to exit on the graceful signal, then the
  same bound again to die once force-killed. The bound is not split between the stages.
- The single-PATH-walk comment (D1, `walkPath`) covers only this Module's executable resolution; it must not be read as excluding the three git spawn sites
  (the Preflight worktree probe and the two Artifact-repo spawns) that pass the bare name `"git"` and let the OS resolve it through PATH.
