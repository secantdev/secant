# process — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The `escalated` flag `interrupt(gracefulMs)` reports is always false on Windows: off Windows a graceful SIGTERM escalates to SIGKILL, but on Windows
  `killGroup` runs `taskkill /T /F`, already forceful, so a Windows child stops within the graceful stage and is never reported `escalated: true`. Read the
  flag as "a forced kill followed the graceful signal", meaningful only off Windows.
- Interrupt and terminate are a two-stage shutdown that shares one `gracefulMs`: the process gets the whole bound to exit on the graceful signal, then the
  same bound again to die once force-killed. The bound is not split between the stages.
- The single-PATH-walk comment (D1, `walkPath`) covers only this Module's executable resolution; it must not be read as excluding the three git spawn sites
  (the Preflight worktree probe and the two Artifact-repo spawns) that pass the bare name `"git"` and let the OS resolve it through PATH.
