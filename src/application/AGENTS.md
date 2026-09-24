# application — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- Every canonical write to a Run must go through `observedOwner`, not the raw `RunOwner`, or an open client's live `run` Projection never updates.
  `observedOwner` spreads `...owner` and intercepts only six methods — `selectHarness`, `writeState`, `publishAttempt`, `recordMaterializationConflict`,
  `recordGateAnswer`, and `recordPendingGate` (the authored gate, #108, which rests the Run `blocked` in its own transaction) — pushing a fresh snapshot
  after each commits. A `run` Projection registers in the Run-scoped observer set even while rested; every later tracking entry reuses that set, so
  resume, gate-answer, and interactive drivers cannot orphan the stream. A new `RunOwner` write method compiles and silently pushes nothing (A3).
- `answer-human-gate` serves two gate mechanisms off one Port operation (#108). The Projection derivation decides which: `derived.pendingGate` present is an
  **authored** gate, answered by settling its producing Attempt through `observedOwner.publishAttempt` (into `attempt_log`, so the resumed walk skips the gate) —
  `free-text` publishes the `text` answer as the gate's declared output and re-drives execution in this process, approve advances `running` and re-drives, reject
  settles `failed` and rests. Otherwise `derived.checkpoint` is a **derived Review checkpoint**, answered by `recordGateAnswer` exactly as M2 did (no `attempt_log`,
  `blocked` stays derived). The live Gate is `derived.pendingGate?.gate ?? derived.checkpoint?.gate` (a blocked Run has exactly one), and the answer form must match
  `gate.shape` (`free-text` ⇒ `text`, `approve-reject` ⇒ `continue`/`stop`) or it is a `gate-shape-mismatch` Problem that changes nothing. Idempotency is keyed on the
  operation id (`gate_answer` row for a checkpoint; the in-process operations map for both) — never on whether the gate settled, so a _different_ operation answering an
  already-answered gate falls through to the staleness check and is refused, not silently masked as `applied`.
- The Trust grant is written only after `createRun` succeeds: any refusal reached before creation (a mismatching trust acknowledgement, a failed
  Preflight) returns without a grant, so it never leaves a dangling one. (`createRun` itself no longer refuses — ADR 0031 admits any number of live
  Runs.) Preflight runs before the Trust gate, so a Run whose preconditions fail is refused before trust is ever asked for.
- New Agent/Interactive-agent Runs require one known, available registry id and pin it in `createRun`; Command-only Runs reject a selection as irrelevant.
  The launch replay key includes the choice, and resume automatically reuses the immutable stored id without deriving it from Attempt evidence (#138, #146).
- A launch's requested model is written into the Run record by `createRun` beside the Harness selection, before the first Attempt, and never changes
  (ADR 0023). Launch and resume hand that stored value to `prepare`; the observed `effectiveModel` never overwrites it (#187).
- Preflight takes the injected `ProcessAdapter` for command resolution and the Git worktree probe; it never constructs one, so tests drive it spawn-free.
- A pre-M4 Run with no selection upgrades only after its still-installed pinned Snapshot proves the routing needs a Harness. Reopen and direct resume
  write `claude-code` once through `observedOwner.selectHarness`; Command-only Runs and missing/corrupt Snapshot Problems remain unselected (#139).
- Never `acquireRun` a Run merely to read it when it is live in another process: acquiring bumps the owner-fencing epoch and would abort the process
  running it. `readResource`/`runResult` read through the live in-process owner when present, else acquire-and-close a rested Run, else refuse with
  `run-live-elsewhere`.
- Execution stores `blocked` before returning a checkpoint pause, and the Application keeps that Run's owner open. The Projection still derives the checkpoint
  facts from the Attempt log, Verdict binding, and Gate answers; the stored state lets dead-owner reconciliation preserve the pending checkpoint.
- The timeline is ordered by `at` (`buildTimeline`), category as the tiebreak for equal instants (A2, #98): events are still built category by category, then sorted,
  so a later Attempt never moves an earlier event. ISO 8601 sorts lexicographically, so the string compare is the time compare.
- When the Attempt log ends on a passing Repeat Verdict, projection advances beyond the group before inspecting the next node. An authored Human Gate already has a
  durable `pending_gate` then but deliberately has no Attempt-log entry until answered; parking on the deciding Command would hide the gate and its answer Offer.
- `liveElsewhere` (a Run live in another process, owner pid alive) is refused before resume/answer claim anything (`run-live-elsewhere`, owner named), and `readResource`
  refuses it too; `listRuns` throwing on a malformed row is caught in cancel/delete so nothing throws out of `submit` (A4).
- The client `RunStateName` has no `created` and gains `cancelled` (A7); the Run Store still records `created` internally, and `toRunState` maps it to `running` for the
  Projection — a launched Run reads `running` from admission.
- The closed registry and prepared Harnesses live in composition, not Application (#116, #146): the Port sees normalized choices/availability, while selected-only
  Preflight sees normalized discovery and capabilities. `makeRunExecution` resolves the durable id and prepares only that Adapter; if it reaches an interactive Step,
  composition transfers an opaque Step driver onto the tracked Run. Every human Turn reuses it, and End, interrupt, cancel, or shutdown closes it exactly once. Preflight
  refuses discovery/capability failures before creation. A typed qualification/authentication/protocol `prepare` failure writes the created Run `halted` before content
  and settles the Operation with `selected-harness-unavailable`. `supportsInteractiveTurns` remains the client fact Application forwards to Preflight.
- `harness-catalog` caches one qualification promise/result per semantic Harness id for the Application lifetime (#188). List calls discovery only; focus initially
  reports `not-checked`, then publishes one durable normalized result. Qualification diagnostics are process-held Resources addressed by semantic id and checked time.
- `launch-preparation` and `submitLaunch` share one create-time evaluator (`LaunchPreparation.evaluate`, `launch-preparation.ts`) so both admit under identical rules (#189):
  `submitLaunch` takes its first finding; the Projection collects all in launch order, each with a `correction` target. Composition-corruption is a single hard-stop `bundle`
  finding like missing/invalid bytes. The model check is assessment-only — the Projection qualifies the selected Harness (`harnessCatalog.qualify`, which spawns) only when the
  draft is otherwise ready and a model is requested; a direct `submitLaunch` skips it, so a bad model surfaces at `prepare`, not as a pre-create refusal.
- The Agent executor's Turn writes (`admitTurn`/`appendTurnEvent`/`settleTurn`) go through the raw owner (not intercepted by `observedOwner`), so they push no **durable**
  snapshot; the Turn's durable timeline, Session availability, and effective model surface on the next intercepted write (the Attempt's `publishAttempt`). The live lane is
  separate — Turn activity reaches an open client through the live overlay (#117, [run-control](../../docs/agents/run-control.md)), not through this durable write.
- The `run` Projection exposes the immutable stored semantic id as `run.selectedHarness` before any Attempt and
  independently exposes the latest Agent-step Attempt's normalized name/executable/version as `run.harness` plus its sibling `effectiveModel` (#125, #147).
  Resume may replace only the observed fields; Command-only Runs omit both selection and observations.
- `deriveRun`'s walk assumes `attempt_log` holds only per-Step Attempts, but the Run Store already appends the reconciliation `indeterminate` marker row
  there (see `store/AGENTS.md`). The marker is harmless only because its outcome is not `succeeded`, not because the walk excludes it — keep that true if
  you add marker rows.
- App-release trust is a recorded Trust grant (operation id `app-release`) that the startup ensure (`shipped-bundles.ts`) writes only on an Entry whose
  origin is `built-in`, re-checked every startup, so launch, resume, and the timeline read it like any grant; `trustState` shows a grant on a built-in as
  `app-release`. Equal bytes a user imported first keep their own origin and trust (#227).
- `createApplication` stays one closure on purpose: its regions share the mutable `runs` map, operations map, and observer sets, it has one caller
  (composition), and no second adapter exists, so extracting a block would only pass a wide context object across a shallow Seam (#199 A1).

## Read next

- Read [run-control](../../docs/agents/run-control.md) before changing deferred settlement, cancel or shutdown, Turn interrupt or steer, takeover, the
  interactive-Step drive, or the live overlay; the abort-reason mapping is [execution's](../run/execution/AGENTS.md).
- `createApplication`'s regions, in order: (1) state, observers, `observedOwner`, and the execution drivers (`runAndSettle`, `startRun`); (2) Projection dispatch
  (`openProjection`, `openRunProjection`), with the catalog and launch-preparation families in their own files; (3) launch and resume (`submitLaunch`,
  `resumePreconditions`, `submitResume`); (4) gate and Harness-request answering, then Turn interrupt and steer (`submitAnswer` through `steerTurnAndSettle`);
  (5) interactive turns (`beginInteractive` through `runInteractiveEnd`), then cancel, delete, read-acquire, and `shutdown`.
