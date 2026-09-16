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

## Tests

- The `tests/harness` domain owns the deterministic fake Adapter, the shared conformance suite, and (from #112) the replayer, recording tool, and the
  `tests/harness/fixtures/<harness>/<case>/` tree with its `recording.json` sidecar.
- The conformance suite is the Seam's executable specification, parameterized by an Adapter factory. It runs against the fake here and against the
  Claude Code Adapter over the replayer from #112, which keeps the fake honest to the Interface. The fake must exhibit behaviours a real Harness never
  will (native steer, structured clarifications, load-with-replay recovery, several concurrent requests, every `lost` variant) and is never the only
  end-to-end double (ADR 0027).

## Read next

- [ADR 0022](../../docs/adr/0022-own-a-truthful-deep-harness-seam.md) is the Interface: read it whole before changing a shape here.
- [Spec #107](https://github.com/secantdev/secant/issues/107) fixes the M3 event vocabulary, result names, and control race values.
