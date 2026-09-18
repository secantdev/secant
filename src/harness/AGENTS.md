# harness — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The public entry (`harness.ts`) is the whole Interface surface: the Adapter Interface, the evidence-bearing profile, and the factory a
  composition root calls. No native frame, protocol type, or conversation-id value crosses it; the declared exceptions are the Workspace path
  (`PrepareOptions.workspace`, the directory every Session runs against), the named native-Adapter test seams on their override types (including Codex's
  recorder-only qualification byte observer), and the executable env constants (`CLAUDE_CODE_EXECUTABLE_ENV` / `SECANT_CLAUDE_CODE` and
  `CODEX_EXECUTABLE_ENV` / `SECANT_CODEX`) — the synchronous discovery outcome
  and static served-capability table that Preflight shares
  with the Adapter (the resolved spawn target stays private), and the permission-bridge factory (`startPermissionBridge`), exported so the fixture
  recorder composes the production bridge instead of a copy (#127 D3); its surface is launch flags, the bearer, a redactor and a teardown, never an MCP type.
  Recovery coordinates cross the Seam only as opaque values
  (`RecoveryCoordinate`), never Run truth — nothing above the Seam decides anything from their contents. Native Adapters,
  protocol models, and qualification stay private to each Adapter and re-export nothing native.
- No Routing, Step kind, retry budget, or Run policy knowledge lives here; those are above the Seam. A Turn is one mechanical exchange, not a
  judgement that a Step succeeded — the closed Turn results (`not-started`, `completed`, `failed`, `interrupted`, `lost`) are mechanical truth, and the
  Step kind decides the Attempt outcome above the Seam.
- Terminal ordering is exact and load-bearing: on terminal an Adapter publishes remaining events, expires every still-outstanding request, closes the
  event producer, then settles the one authoritative result. No event is observable after the result settles. The fake enforces this with an
  `emit after result` guard; a real Adapter must hold the same order.
- A Turn result may settle before its native child emits `close`. Claude Session reuse tracks which Turn owns the child, lets an already-settled close
  win before the next send, and never attributes an old child's close to the next Turn; a still-live child may accept the next Turn in place.
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

## Invariants (interrupt, recovery, cleanup)

- Confirmed interruption uses the process Module's `interrupt(gracefulMs)`, which reports whether a forced escalation was needed. A graceful stop ends
  the Turn `interrupted` (process-only); a force-kill or unconfirmed termination ends it `lost` with `interruption-unknown`. On Windows the process
  Module has no graceful stage (a hidden console child cannot observe one, #127 A6 amended), so a live Claude Code is force-killed at once and every
  Windows interrupt of a live Turn truthfully settles `lost`; the profile's interruption evidence says so there, and the conformance `interruptOutcome`
  option (on both the interrupt/recovery and the approval-request case groups) pins it per OS. `onClosed` yields to an
  in-flight interrupt so the two never race the result: a confirmed interrupt claims the process before awaiting, and the close path (`onClosed`) returns
  early when `this.process !== owned`, leaving the interrupt to settle the one authoritative result.
- Recovery is caller- and history-driven: a relaunch of a Session that already ran, or any Turn carrying `resume`, spawns with `--resume` (never a fresh
  `--session-id`). Init state is per process. A resumed init that does not echo the coordinate is a `recovery`-phase failure that marks the Session
  `unusable`; recovery never silently starts a fresh conversation.
- Authentication is recognized from the stdout result (no typed auth field exists in the print-mode contract) and surfaced as the fixed
  `AUTHENTICATION_REQUIRED` message only — the raw result never crosses the Seam, since it may quote a key. #115's recording pinned the signal: a
  not-logged-in run returns `subtype:"success"` with `result:"Not logged in · Please run /login"`, so the auth check runs before the success branch.

## Invariants (Claude Code Adapter internals)

- Qualification is cached per Adapter instance in a private `Map`, keyed by the discovered target's discovery source, its path, and its file identity: same
  path with identical bytes ⇒ the probed version cannot have changed, so the cached profile is reused without re-running `--version`; any drift in path or
  identity requalifies, and folding the source into the key stops a reused profile reporting a stale source.
- The permission bridge mints a 256-bit per-Run bearer token for its loopback MCP server; the token lives only in the `--mcp-config` argv and the server's
  constant-time auth check. The Session holds the bridge's `redactSecret` from launch and routes every failure cause originating below launch through it
  (`scrub` on each close observation; the stdin-write and stdout-read errors and the captured stderr text too), so the rule is "redact at the Seam",
  not one spawn-error path (#127 A22).
- The stream-json protocol model is the private `claude-code/frames.ts`: one `zod` schema per known frame type (`init`, `assistant`, `user`,
  `stream_event`, `result`, `telemetry`), parsed per frame by `parseFrame`, with the pure readers and the only raw-field accessors. Only the fields dispatch
  iterates over are structurally required (a message's content array, a stream event's object; a `result` always settles, a missing `subtype` as
  `unknown-result`); every other field degrades to absent (`.catch(undefined)`), unknown fields pass through, and a known type whose
  parse fails or an unknown type is generic activity — never protocol corruption. `claude-code.ts` dispatches on `ParsedFrame` and reads no raw field.
- `OwnedProcess.writeStdin` resolves only after both the write callback has fired without error and the stream has drained (it waits for the `drain` event
  when `write` returned `false`); an error rejects. The Turn's bytes are accepted before the write promise settles, which is what the durable-admission
  ordering rests on.
- `consumeStdout` is a hand-rolled NDJSON splitter (D15): it splits on `\n`, strips a trailing `\r`, and JSON-parses only a line that trims to something
  starting with `{` (any other line is ignored; a parse error is a `malformed JSON frame`). After the stream ends, a final flush whose trimmed remainder
  still starts with `{` is the distinct `truncated JSON frame` diagnostic a recorded protocol-corruption fixture pins.
- `acceptInit` compares the native `session_id` to the minted coordinate. A mismatch on a **resume** is a `recovery`-phase `recovery-unacknowledged` failure
  that marks the Session unusable (never a silent fresh conversation); a mismatch on a **fresh launch** is `not-started`/`init-session` — the minted id was
  simply never echoed, so the Turn never started.
- Authentication is recognized before the success branch, but the guard fires only when `isAuthenticationResult(frame)` and (`subtype !== "success"` or
  `is_error === true`): the pinned not-logged-in signal is `subtype:"success"` with `is_error:true`, so a real answer whose text merely quotes a login
  phrase settles `is_error:false` and stays a completed Turn. The raw result never crosses the Seam — only `AUTHENTICATION_REQUIRED` does.
- Session unusability is stored as a private `unusableReason` on the Session, set by `markUnusable` when a resume is not acknowledged; the Turn-start path
  (`submit`) reads it first and fails every further Turn with the same recovery failure, never opening a fresh conversation.

## Invariants (Codex qualification)

- `codex.ts` owns Adapter orchestration, cache and profile; `codex/qualification.ts` owns the bounded pre-thread JSONL exchange and diagnostics;
  `codex/required-schema.ts` owns structural compatibility. Unlike Claude's runtime `frames.ts`, the required-schema file validates generated
  qualification evidence; later Codex Turn frames belong in their own runtime protocol submodule.
- Every `prepare` observes `codex --version`; cached schema evidence is keyed by discovery source, path, SHA-256 identity, version, platform, and revision.
  The host platform driving discovery/profile is immutable; only the cache-key test seam varies platform evidence. A hit skips schema generation only.
- Live qualification owns one `codex app-server` child, sends exactly one `initialize` then `initialized`, runs only bounded `account/read` and
  `model/list` probes, creates no thread, Turn, or prompt, and retains that initialized child in the Prepared Harness.
- Codex inherits user environment/home; unauthenticated becomes the fixed separate-login remediation, and no account or credential crosses the Seam.

## Tests

- The `tests/harness` domain owns the deterministic fake Adapter, the shared conformance suite, and the `claude` replayer. Its argv parser and recorded
  `--version` landed in #111; #112 added per-Turn protocol replay. #115 replaced the hand-authored `protocol-cases/` tree with the recorded (and residual
  synthetic) `tests/harness/fixtures/<harness>/<case>/` tree, its `recording.json` sidecar, and the opt-in `record.ts` tool.
- The conformance suite is the Seam's executable specification, parameterized by an Adapter factory. `runPrepareProfileCases` and `runTurnLifecycleCases`
  and `runInterruptRecoveryCases` (interrupt, unresponsive-interrupt, lost-completion, resume ack/no-ack, close-mid-Turn) and `runApprovalRequestCases`
  run against both the fake and the Claude Code Adapter over the replayer. Only five tail cases stay fake-only: native steer, structured clarifications,
  the after-acceptance recovery checkpoint, load-with-replay recovery, and the caller-contract violations (the only things this Interface throws for).
  The fake must exhibit behaviours a real Harness never will (native steer, structured clarifications, load-with-replay recovery, several concurrent
  requests, every `lost` variant) and is never the only end-to-end double (ADR 0027). The fake performs load-with-replay rather than advertising it: a
  resumed Turn re-emits the Session's transcript history (`assistant-content`, `tool-activity`), drops a scripted entry that repeats a replayed one, then
  emits `REPLAY_BARRIER` (an `activity`) before any live event — history is historical by position, inside the closed vocabulary.
- **`bun test` startup-signal race:** a Bun child's `process.on("SIGTERM")` handler is only honoured once installed — a SIGTERM delivered before the
  child's top-level code runs hits the default disposition and kills it (this is a startup race, not a `bun test` limitation; plain `bun` shows the same
  window). So the replayer installs its SIGTERM handler at startup, and interrupt/close cases wait for the `session` event (init observed) before
  interrupting. Never signal a freshly spawned child before it has announced readiness.
- The replayer's `case.json` carries the interrupt/recovery vocabulary: `ignoreSigterm` (swallow SIGTERM → force-kill path; moot on Windows, where every
  live child is force-killed regardless), per-turn `exitAfter` (exit without a result → lost/corruption), and a `resume` section replayed when the launch
  has `--resume`.

## Read next

- [ADR 0022](../../docs/adr/0022-own-a-truthful-deep-harness-seam.md) is the Interface: read it whole before changing a shape here.
- [Spec #107](https://github.com/secantdev/secant/issues/107) fixes the M3 event vocabulary, result names, and control race values.
