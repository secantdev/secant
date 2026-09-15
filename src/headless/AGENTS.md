# headless — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- Exit-code contract: the headless Run commands exit 0 only when the Run rests exactly `succeeded`, **2** when it rests `blocked` at its Human Gate
  checkpoint (the M2 gate's expected outcome — distinguished from a failure so CI can assert it), and 1 for every other rest (A36, `exitForState` in
  `run-commands.ts`). Because `blocked` now has its own code, the package smoke asserts it through its `run()` helper's `expect` option rather than raw
  `spawnSync`.
- `run answer` gates on the Port's `answer-human-gate` Offer (A14): the Offer owns legality and carries the exact Gate reference, so its absence — not a
  client re-derivation from `run.state` — refuses an unanswerable Run, and submitting against `offer.gate` lets the Application catch a Gate that moved
  as stale. Never classify the answer or synthesize the reference here.
- The `run` command group lives in `run-commands.ts` and registers onto the program `buildProgram` passes (A25); it is handed `io`/`execute`/`fail`/`settle`
  and shares `settledOutcome` and `settleAndReportRun` (the await-settlement-then-report tail, A24). `splitSelector` lives there too and `bundle inspect`
  imports it (A24).
- The `--json` shapes are frozen: the three-OS CI gate parses specific fields (`.result.run.state`, `.checkpoint.completedIterations`, …), so renaming
  one breaks the gate. They are not uniform — `bundle inspect --json` prints the inner bundle while `bundle list --json` prints the snapshot — so match
  the existing shape a command already emits.
- Commander settings (`exitOverride`, `configureOutput`, `enablePositionalOptions`, `configureHelp`) must be configured on the program before the
  `.command(...)` calls: Commander copies them into each subcommand as it is added, so a subcommand added before a setting silently misses it.

## Tests

- The exit-code and `--json` contracts above are the CI acceptance seam; `tests/cli` does not exist (the tiny entry branches in `cli/main.ts` are
  covered by the package smoke and a child-process spawn), so assert headless behaviour here and in the package smoke, not through a separate CLI suite.
