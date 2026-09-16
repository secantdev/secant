# harness — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The public entry (`harness.ts`) is the whole Interface surface: the Adapter Interface, the evidence-bearing profile, and the factory a
  composition root calls. It names no native conversation id, filesystem path, raw protocol frame, or protocol type. Recovery coordinates cross the
  Seam only as opaque values (`RecoveryCoordinate`), never Run truth — nothing above the Seam decides anything from their contents. Native Adapters,
  protocol models, and qualification stay private to each Adapter and re-export nothing native.
- No Routing, Step kind, retry budget, or Run policy knowledge lives here; those are above the Seam. A Turn is one mechanical exchange, not a
  judgement that a Step succeeded — the closed Turn results (`not-started`, `completed`, `failed`, `interrupted`, `lost`) are mechanical truth, and the
  Step kind decides the Attempt outcome above the Seam.
- Terminal ordering is exact and load-bearing: on terminal an Adapter publishes remaining events, expires every still-outstanding request, closes the
  event producer, then settles the one authoritative result. No event is observable after the result settles. The fake enforces this with an
  `emit after result` guard; a real Adapter must hold the same order.
- Operational failures are typed values (`HarnessFailure`, `ControlReceipt` rejections, `RecordingReceipt`, `CleanupReport`). Only caller-contract
  violations throw: a second concurrent Turn on one Prepared Harness, a Turn after `close`, or a Turn beyond what an Adapter can serve. Control races
  (`expired`, `already-settled`, `shape-mismatch`, `unsupported`) are rejected receipts, never throws.
- Durable admission precedes content. `startTurn` returns a handle before native acceptance, but an Adapter awaits `recorder.admit` before sending
  content; a `recorded: false` receipt (or a thrown recorder) proves the Turn `not-started`. A recovery coordinate revealed only after acceptance is
  recorded through `recorder.checkpoint`; a late checkpoint failure is reported separately and never rewrites a settled result.
- `close` is idempotent and returns the same report each call; cleanup failure is separate and cannot rewrite a settled Turn.
- Secrets Secant itself introduces are redacted from failures and diagnostics. Excluding raw protocol, private reasoning, and duplicate transcript
  content is Interface design, not generic secret redaction — a `HarnessFailure` still preserves all useful Harness-originated diagnostics and its cause.

## Invariants (interrupt, recovery, cleanup)

- Confirmed interruption uses the process Module's `interrupt(gracefulMs)`, which reports whether a forced escalation was needed. A graceful stop ends
  the Turn `interrupted` (process-only); a force-kill or unconfirmed termination ends it `lost` with `interruption-unknown`. `onClosed` yields to an
  in-flight interrupt (a shared close promise resolves both) so the two never race the result — the `interruptInFlight` guard is load-bearing.
- Recovery is caller- and history-driven: a relaunch of a Session that already ran, or any Turn carrying `resume`, spawns with `--resume` (never a fresh
  `--session-id`). Init state is per process. A resumed init that does not echo the coordinate is a `recovery`-phase failure that marks the Session
  `unusable`; recovery never silently starts a fresh conversation.
- Authentication is recognized from the stdout result (no typed auth field exists in the print-mode contract) and surfaced as the fixed
  `AUTHENTICATION_REQUIRED` message only — the raw result never crosses the Seam, since it may quote a key. #115's recordings will pin the signal.

## Tests

- The `tests/harness` domain owns the deterministic fake Adapter, the shared conformance suite, and the `claude` replayer. Its argv parser and recorded
  `--version` landed in #111; #112 added per-Turn protocol replay from hand-authored `tests/harness/protocol-cases/`. #115 owns the recording tool and
  `tests/harness/fixtures/<harness>/<case>/` tree with its `recording.json` sidecar.
- The conformance suite is the Seam's executable specification, parameterized by an Adapter factory. `runPrepareProfileCases` and `runTurnLifecycleCases`
  and `runInterruptRecoveryCases` (interrupt, unresponsive-interrupt, lost-completion, resume ack/no-ack, close-mid-Turn) run against both the fake and
  the Claude Code Adapter over the replayer; the request/steer/clarification cases stay fake-only. The fake must exhibit behaviours a real Harness never
  will (native steer, structured clarifications, load-with-replay recovery, several concurrent requests, every `lost` variant) and is never the only
  end-to-end double (ADR 0027).
- **`bun test` startup-signal race:** a Bun child's `process.on("SIGTERM")` handler is only honoured once installed — a SIGTERM delivered before the
  child's top-level code runs hits the default disposition and kills it (this is a startup race, not a `bun test` limitation; plain `bun` shows the same
  window). So the replayer installs its SIGTERM handler at startup, and interrupt/close cases wait for the `session` event (init observed) before
  interrupting. Never signal a freshly spawned child before it has announced readiness.
- The replayer's `case.json` carries the interrupt/recovery vocabulary: `ignoreSigterm` (swallow SIGTERM → force-kill path), per-turn `exitAfter` (exit
  without a result → lost/corruption), and a `resume` section replayed when the launch has `--resume`.

## Read next

- [ADR 0022](../../docs/adr/0022-own-a-truthful-deep-harness-seam.md) is the Interface: read it whole before changing a shape here.
- [Spec #107](https://github.com/secantdev/secant/issues/107) fixes the M3 event vocabulary, result names, and control race values.
