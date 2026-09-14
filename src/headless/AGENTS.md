# headless — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- Exit-code contract: the headless process exits 0 only when the Run's terminal state is exactly `succeeded`; every other rest exits non-zero (1 today).
  A Run resting `blocked` at its Human Gate checkpoint — the M2 gate's expected outcome — is therefore a non-zero exit, deliberate and tested. That is
  why the CI package smoke checks those cases with raw `spawnSync` and inspects `status` by hand, rather than its throw-on-non-zero `run()` helper.
- `run answer` must re-read `run.checkpoint.gate` from the live `run` Projection snapshot and submit against that exact reference, so a Gate that moved
  between the read and the submit is caught as stale by the Application. Never classify the answer or synthesize the reference here.
- The `--json` shapes are frozen: the three-OS CI gate parses specific fields (`.result.run.state`, `.checkpoint.completedIterations`, …), so renaming
  one breaks the gate. They are not uniform — `bundle inspect --json` prints the inner bundle while `bundle list --json` prints the snapshot — so match
  the existing shape a command already emits.
- Commander settings (`exitOverride`, `configureOutput`, `enablePositionalOptions`, `configureHelp`) must be configured on the program before the
  `.command(...)` calls: Commander copies them into each subcommand as it is added, so a subcommand added before a setting silently misses it.

## Tests

- The exit-code and `--json` contracts above are the CI acceptance seam; `tests/cli` does not exist (the tiny entry branches in `cli/main.ts` are
  covered by the package smoke and a child-process spawn), so assert headless behaviour here and in the package smoke, not through a separate CLI suite.
