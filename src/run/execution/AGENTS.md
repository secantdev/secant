# execution — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The abort-reason vocabulary is owned here (the cancel Seam's sentinel strings, imported by the Application) and maps to the Run's resting state: all three
  reasons stop a live Turn, and the reason decides the rest — `RUN_CANCEL_ABORT` ends the Run `cancelled` (the terminal cancel-run), while
  `INTERRUPT_TURN_ABORT` (a Port control) and `SIGNAL_ABORT` (Ctrl+C or an OS signal) rest it `halted`, resumable (ADR 0019).
- The Harness-facing half publishes nothing durable except through the three admitted Turn writes (`admitTurn`, `appendTurnEvent`, `settleTurn`); every
  other durable Run fact surfaces on the Attempt's later `publishAttempt`, never from executing a Turn.
- Every autonomous Agent Attempt publishes one co-sourced evidence value: qualified Harness identity plus its optional observed model. `attemptEvidence`
  fails fast if an Agent result lacks identity; Command/Gate and synthetic interactive Attempts publish neither (#147).
- Every Command-step spawn passes its resolved authored environment through the Run Store entry's `isolatedGitEnvironment`; the helper appends
  non-interactive signing, hook, credential, and editor overrides after authored Git config entries, without changing user files or hiding ordinary
  system/global config (#166). `GIT_CONFIG_PARAMETERS` is removed because Git applies it after the counted entries and could undo the hardening.
