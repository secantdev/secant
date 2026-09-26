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
- An Agent Step's declared `text` outputs come only from Output receipts (#215): after a `completed` Turn each receipt must be a regular UTF-8 file of at most
  64 KiB, non-empty once trimmed, or the Attempt fails (retryable) and moves no binding. Assistant prose is never read as an output or as Routing control.
- Receipt paths reach the Agent only as appended prompt text — one `receiptInstruction` line per declared output after the rendered prompt — never as an env var
  or Harness option. A prompt-renderer or `produces` change that drops those lines fails every Agent Step that declares an output.
- Execution never hands the working area to the Harness; composition's prepare does (#214). Here it only fills the `{{run:working-area}}` prompt slot
  (`WORKING_AREA_SLOT`) and gates receipts when `produces` is non-empty, each an unusable area typed `working-area-unavailable`/`not-started`; Command steps never
  see it — their `cwd` resolves against the Workspace.
- Every Command-step spawn passes its resolved authored environment through the Run Store entry's `isolatedGitEnvironment`; the helper appends
  non-interactive signing, hook, credential, and editor overrides after authored Git config entries, without changing user files or hiding ordinary
  system/global config (#166). `GIT_CONFIG_PARAMETERS` is removed because Git applies it after the counted entries and could undo the hardening.
- An interactive-agent Step's Entry Turn (`entryTurn`) is due only while no Turn of its Attempt was admitted, so resume never re-sends it; an interrupted or
  lost Entry Turn rests the Run `halted` without publishing an Attempt, and only `end-interactive-step` publishes one (#212).
- `runRepeatGroup` has two branches (#217): the Verdict-driven one re-reads `until` after each iteration and blocks at the Review cadence; the human-controlled
  one (`control: "human"`) reads no Verdict and raises no checkpoint, resting `blocked` at each iteration's interactive Step. Neither reads agent text to choose the exit.
- Continue and End Stage settle an iteration only at a Turn boundary. Confirmed End Stage publishes that iteration's Attempt
  marked `endsStage`, so the walk exits the group once and a trailing group rests the Run `succeeded` as human-declared completion, never a second settle (#218).
- Each Repeat iteration of an Interactive Step is its own Attempt (`encodeAttemptId` carries the iteration) with its own Session (`interactiveSession` scopes the
  name to that Attempt id), so Continue always opens a fresh conversation; `interactiveStepTarget` finds the resting iteration from the log (#216).
