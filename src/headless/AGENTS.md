# headless — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- Exit-code contract: the headless Run commands exit 0 only when the Run rests exactly `succeeded`, **2** when it rests `blocked` at its Human Gate
  checkpoint (the M2 gate's expected outcome — distinguished from a failure so CI can assert it), and 1 for every other rest (A36, `exitForState` in
  `run-commands.ts`). Because `blocked` now has its own code, the package smoke asserts a rest-state exit through its `run()` helper (its `expect` option) rather
  than a raw `spawnSync`; but raw `spawnSync` sites deliberately remain for the spawns that expect a non-zero/failure exit and for the long-lived child processes
  (SIGINT, takeover), which `run()`'s default exit-0 contract does not fit (A35). This rest-state exit is only `launch`, `resume` and `answer` — the three
  commands that drive to settlement through `settleAndReportRun`;
  `show`, `list`, `read`, `cancel` and `delete` exit 0 on success (or 1 on a refusal), never by rest state. On Ctrl+C the signal handler (`withClients`,
  `composition/main.ts`, #98) aborts the live Runs, restores the default disposition, and re-raises the signal, so the process exits **128 plus the signal
  number** rather than 1 — the Unix "killed" contract a CI script reads, which a fabricated 1 destroys. The `halted` rest lands lazily: the claim is left
  live and the next open reconciles it `halted` (ADR 0019), not the signalled process.
- `run answer` gates on the Port's `answer-human-gate` Offer (A14): the Offer owns legality and carries the exact Gate reference, so its absence — not a
  client re-derivation from `run.state` — refuses an unanswerable Run, and submitting against `offer.gate` lets the Application catch a Gate that moved
  as stale. Never classify the answer or synthesize the reference here. `run answer` takes `--continue`/`--stop` (approve-reject and checkpoints) or
  `--text <value>` (a free-text authored gate, #108) — exactly one, tested by presence so `--text ""` is a valid empty answer. The client never re-classifies
  the gate shape: a `--text` answer to an approve-reject gate (or vice versa) is forwarded and the Application refuses it as `gate-shape-mismatch`.
- A Run that rests `blocked` at a gate names its follow-up answer command in the plain-text tail (`settleAndReportRun`'s `answerHint`, #108): a free-text
  gate names `--text`, an approve-reject gate names `--continue`/`--stop`. `run show` names the blocked basis for all three cases (A15): the durable Human Gate
  (the authored pending gate's shape/message/output and the derived Review checkpoint, both under the `answer-human-gate` Offer's `basis`), the interactive Turn
  (from the `send-interactive-turn` Offer's `basis`), and the ephemeral Harness Request. The first two are durable `RunView` fields renderRun prints; the ephemeral
  request is never durable, so `showRun` peeks the live overlay (`peekLiveOverlay` — a bounded first-update read that returns the overlay buffered at open while a
  Turn is live here, else nothing) and names the outstanding request. All of it is additive to the frozen `--json`, whose shape is the durable snapshot alone.
- `run show` renders the Harness identity of the latest Agent-step Attempt (#125) — `Harness:`/`Executable:`/`Version:` lines beside `Effective model:` — from the additive
  `run.harness` view; the version prints unadorned (no `v` prefix, matching the TUI header) since a real version string can itself contain parentheses. The existing top-level
  `effectiveModel` `--json` field is untouched and the new `harness` object is purely additive, so a Command-only Run's frozen shape is unchanged.
- The `run` command group lives in `run-commands.ts` and registers onto the program `buildProgram` passes (A25); it is handed `io`/`execute`/`fail`/`settle`
  and shares `settledOutcome` and `settleAndReportRun` (the await-settlement-then-report tail, A24). `splitSelector` lives there too and `bundle inspect`
  imports it (A24).
- `launch`/`resume` answer approval Harness Requests while following the live Run (#117), all through one owner — `harness-requests.ts` holds the
  `--harness-requests` option (`addHarnessRequestsOption`, declared on both commands), its parser, and the follower (A34; the option was declared verbatim on
  each command and the follower wrapped in an identical try/finally before). `followHarnessRequests` opens the `run` Projection and, on each `live` overlay,
  submits `answer-harness-request` (as `client-policy`) for every offer not yet in its `attempted` set — the key is `generation:requestId`, so a request
  re-offered at a later generation (a prior answer went stale) is retried. `--harness-requests` defaults to **`deny`** (`parseHarnessRequestPolicy`): an
  unattended Run denies every approval unless the operator opts into `allow` (the only other value; Claude Code offers no "always"). `withHarnessRequests` starts
  the follower before settlement is awaited, so an Agent Turn that pauses on approval is unblocked and the Run can rest; it is harmless for a Command-only Run.
- `run launch --harness claude-code|codex` forwards the semantic choice through `LaunchRunInput`; Application owns required/unknown/irrelevant refusal. Resume accepts
  no Harness flag and reuses the durable id. The option changes no frozen JSON field or exit code; selected-Harness Problems use the existing renderer (#146).
- `run read --transcript` (#124) selects the Session from `<run-id>/<session>` then `--session`; with neither it takes the sole Session that has a recorded
  transcript. It refuses `run-session-not-found` when the named Session has no transcript, when the Run has none at all, or when more than one Session exists
  and none was named (`readTranscript`). `run show` never inlines transcript entries; the Session's page/export References are the only read path.
- `render.ts` ignores an unknown action-offer kind on purpose: each offer kind is rendered by its own filtered loop, so an offer kind the client does not
  recognise falls through every loop and prints nothing rather than erroring — the client never enumerates a closed set of offers.
- The `--json` shapes are frozen: the three-OS CI gate parses specific fields (`.result.run.state`, `.checkpoint.completedIterations`, …), so renaming
  one breaks the gate. They are not uniform — `bundle inspect --json` prints the inner bundle while `bundle list --json` prints the snapshot — so match
  the existing shape a command already emits.
- Commander settings (`exitOverride`, `configureOutput`, `enablePositionalOptions`, `configureHelp`) must be configured on the program before the
  `.command(...)` calls: Commander copies them into each subcommand as it is added, so a subcommand added before a setting silently misses it.

## Tests

- The exit-code and `--json` contracts above are the CI acceptance seam; `tests/cli` does not exist (the tiny entry branches in `cli/main.ts` are
  covered by the package smoke and a child-process spawn), so assert headless behaviour here and in the package smoke, not through a separate CLI suite.
  Named gap (testing.md "Behavioral Completeness", A64): three `cli/main.ts` behaviours are covered **only** by the compiled-binary smoke, never the
  deterministic suite — the bare-argv branch that lazily imports the TUI so Solid and OpenTUI never load on a headless path (`:19-25`); `isMainEntry`'s
  `Bun.main` separator normalisation, the #62 Windows entry quirk (`:48-53`); and the top-level error handler that prints a stack and sets exit 1
  (`:55-62`). The file records at `:40-47` why it cannot be unit-tested as written; if a fourth branch appears, revisit a small `tests/cli` rather than
  widening the smoke.
