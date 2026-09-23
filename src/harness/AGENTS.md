# harness — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The public entry (`harness.ts`) is the whole Interface surface: the Adapter Interface, the evidence-bearing profile, and the factory a
  composition root calls. No native frame, protocol type, or conversation-id value crosses it; the declared exceptions are the Workspace path
  (`PrepareOptions.workspace`, the directory every Session runs against), the named native-Adapter test seams on their override types (including Codex's
  recorder-only schema, stdio, stderr, and shutdown observer), and the executable env constants (`CLAUDE_CODE_EXECUTABLE_ENV` / `SECANT_CLAUDE_CODE` and
  `CODEX_EXECUTABLE_ENV` / `SECANT_CODEX`) — the synchronous discovery outcome and static served-capability table that Preflight shares
  with the Adapter (the resolved spawn target stays private), and the permission-bridge factory (`startPermissionBridge`), exported so the fixture
  recorder composes the production bridge instead of a copy (#127 D3); its surface is launch flags, the bearer, a redactor and a teardown, never an MCP type.
  Recovery coordinates cross the Seam only as opaque `RecoveryCoordinate` values, never Run truth; callers never decide from their contents. Native
  protocol models and qualification stay private to each Adapter and re-export nothing native.
- No Routing, Step kind, retry budget, or Run policy knowledge lives here; those are above the Seam. A Turn is one mechanical exchange, not a
  judgement that a Step succeeded — the closed Turn results (`not-started`, `completed`, `failed`, `interrupted`, `lost`) are mechanical truth, and the
  Step kind decides the Attempt outcome above the Seam.
- Terminal ordering is exact and load-bearing: on terminal an Adapter publishes remaining events, expires every still-outstanding request, closes the
  event producer, then settles the one authoritative result. No event is observable after the result settles. The fake enforces this with an
  `emit after result` guard; a real Adapter must hold the same order.
- A Turn result may settle before its native child emits `close`; an Adapter that reuses a child across Turns never attributes an old child's close to the
  next Turn (the Claude Code mechanics are in [harness-adapters](../../docs/agents/harness-adapters.md)).
- Operational failures are typed values (`HarnessFailure`, `ControlReceipt` rejections, `RecordingReceipt`, `CleanupReport`). Only caller-contract
  violations throw: a second concurrent Turn on one Prepared Harness, a Turn after `close`, or a Turn beyond what an Adapter can serve. Control races
  (`expired`, `already-settled`, `shape-mismatch`, `unsupported`) are rejected receipts, never throws.
- Durable admission precedes content. `startTurn` returns a handle before native acceptance, but an Adapter awaits `recorder.admit` before sending
  content; a `recorded: false` receipt (or a thrown recorder) proves the Turn `not-started`. A recovery coordinate revealed only after acceptance is
  recorded through `recorder.checkpoint`; a late checkpoint failure is reported separately and never rewrites a settled result.
- `close` is idempotent and returns the same report each call; cleanup failure is separate and cannot rewrite a settled Turn.
- Secrets Secant itself introduces are redacted from failures and diagnostics. Excluding raw protocol, private reasoning, and duplicate transcript
  content is Interface design, not generic secret redaction — a `HarnessFailure` still preserves all useful Harness-originated diagnostics and its cause.
- Steer is a profile capability like the others (`HarnessProfile.steer`, evidence-bearing). An Adapter derives its `steer` receipt from it rather than
  hard-coding a second rejection; the Claude Code profile declares it unavailable (print mode has no same-Turn guidance frame) and the fake's script
  decides it through the profile it supplies.

- Model selection is a profile fact. `modelSelection` declares where a model can be chosen (`launch`, `per-turn`, both, or `unavailable`) and carries a
  `ModelDeclaration`: a `list` of admitted models or `free-text`. `modelObservation` separately declares whether the effective model is read from native
  evidence. Codex declares `launch-and-per-turn` with the `model/list` result observed at qualification; Claude Code declares `launch` with free text
  (`--model`). Both observe the effective model.
- `PrepareOptions.requestedModel` is the caller's durable request, normalized identically by both Adapters (empty means none). A request outside a declared
  list, including an empty one, is a typed `model-unavailable` prepare failure, never a substitution; free text forwards any value. The effective model a
  Turn reports is observed and never copies the request.

## Invariants (interrupt, recovery, cleanup)

- A Turn settles `interrupted` only on confirmed interruption; a force-kill, lost connection, or unconfirmed termination settles it `lost` with
  `interruption-unknown`. On Windows the process Module has no graceful stage (a hidden console child cannot observe one, #127 A6 amended), so a
  process-signal interrupt of a live child there is a force-kill and truthfully settles `lost`. The profile's interruption evidence states what each
  Harness delivers per OS, and the conformance `interruptOutcome` option (on both the interrupt/recovery and the approval-request case groups) pins it.
- Recovery is caller- and history-driven: a relaunch of a Session that already ran, or any Turn carrying `resume`, resumes that exact native conversation.
  A resume the native side does not acknowledge is a `recovery`-phase failure that marks the Session `unusable`; recovery never silently starts a fresh
  conversation. Each Adapter's resume mechanics are in [harness-adapters](../../docs/agents/harness-adapters.md).

## Tests

- The `tests/harness` domain owns the deterministic fake Adapter, shared conformance, and native replayers. Recorded and residual synthetic cases live in
  `tests/harness/fixtures/<harness>/<case>/` with a `recording.json` sidecar and opt-in recorder.
- Prepare/lifecycle cases run all Adapters; Codex replay covers exact-thread recovery, approvals, and native Steer. Other control groups stay capability-specific.
  Structured clarifications, after-acceptance checkpoint, load-with-replay, and caller-contract violations remain fake-only. The fake performs load-with-replay:
  resumed Turn re-emits the Session's transcript history (`assistant-content`, `tool-activity`), drops a scripted entry that repeats a replayed one, then
  emits `REPLAY_BARRIER` (an `activity`) before any live event — history is historical by position, inside the closed vocabulary.
- Native Adapter and replayer conformance runs only in the standalone runtime-conformance program (#198), never under `bun test`; the layer rules are in
  [testing](../../docs/agents/testing.md).
- **Replayer startup-signal race:** a Bun child's `process.on("SIGTERM")` handler is only honoured once installed — a SIGTERM delivered before the
  child's top-level code runs hits the default disposition and kills it (this is a startup race, not a `bun test` limitation; plain `bun` shows the same
  window). So the replayer installs its SIGTERM handler at startup, and interrupt/close cases wait for the `session` event (init observed) before
  interrupting. Never signal a freshly spawned child before it has announced readiness.
- The replayer's `case.json` carries the interrupt/recovery vocabulary: `ignoreSigterm` (swallow SIGTERM → force-kill path; moot on Windows, where every
  live child is force-killed regardless), per-turn `exitAfter` (exit without a result → lost/corruption), and a `resume` section replayed when the launch
  has `--resume`.

## Read next

- Read [harness-adapters](../../docs/agents/harness-adapters.md) before changing Claude Code or Codex Adapter internals.
- Read [ADR 0022](../../docs/adr/0022-own-a-truthful-deep-harness-seam.md) before changing the Interface; [Spec #107](https://github.com/secantdev/secant/issues/107) fixes the M3 event vocabulary, result names, and control race values.
