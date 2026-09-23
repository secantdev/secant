# Use One Deep Projection Port for TUI and Headless Clients

Crucible uses one transport-neutral **Projection Port** for both TUI and headless callers, with three conceptual entry points: open one of six closed bounded **Projection** families, submit typed user intent as an idempotent **Operation**, and read large or differently retained content through typed **Resource References**. Opening a Projection atomically joins its authoritative snapshot, durable catch-up barrier, and future updates; durable state, ephemeral live Harness state, and replaceable previews remain visibly distinct, while typed **Action Offers** keep action legality and stale-target protection inside Crucible rather than in callers.

The Interface deliberately separates operation admission, operation outcome, and subsequent Run or Harness work; keeps complete history, transcripts, Artifact bytes, file sets, exports, and diagnostics outside bounded snapshots; and exposes normalized Problems instead of persistence, workflow-runtime, Adapter, or Harness-native objects. This makes normal progressive output a property of the Run projection rather than an Operation status screen, lets slow or reconnecting observers recover without blocking execution, and preserves truthful differences among Human Gates, Harness Requests, ordinary assistant questions, and Harness capabilities.

We rejected an observe-only minimal facade because one-shot reads and intent outcomes become awkward observations, and a separate read/observe surface because callers must then close the race between hydration and subscription. We also reject generic queries, generic commands, client-side domain reducers, screen-shaped view models, and unknown-variant escape hatches: the Port stays deep by owning normalization, ordering, catch-up, action offers, idempotency, and resource boundaries while its closed semantic variants evolve with bundled callers in one product release. The complete contract and projection/action/resource vocabularies are recorded in [Define Crucible's TUI-facing command and projection interface](https://github.com/DevFlow-HQ/devflow-cli/issues/19).

## Amendment (2026-09-09): the seventh `workspace` Projection family

The "six closed bounded Projection families" above become seven. The M1 shell adds a `workspace` family — the one launch Workspace, no selector, rebase-only catch-up, and the `approve-workspace` Action Offer while it is unapproved — alongside a durable `approve-workspace` Operation that is idempotent on equal input and settles `applied` or `not-applied`. This extends the #19 vocabulary; the amendment is recorded there and delivered by [issue #50](https://github.com/secantdev/secant/issues/50). No other decision here changes.

## Amendment (2026-09-13): the eighth `run-list` Projection family and the `cancel-run`/`delete-run` Operations

Previous Runs join the closed families as an eighth, Workspace-scoped `run-list` — a bounded, newest-first page whose rows carry only the Bundle name, Run id, and latest durable-activity time (Run state and actions stay on the exact `run` Projection), grouped Today / Yesterday / Older, filtered All or Resumable, paged by a stable `before` cursor that ends in a beginning-of-history marker, with an informational empty snapshot. Two durable Operations join the closed set: `cancel-run` ends a live Run `cancelled` (the only route to that terminal state) and `delete-run` removes a resting or terminal Run's store, both idempotent per operation id and offered as typed `run` Action Offers only when legal, legality decided inside Secant. This extends the #19 vocabulary and is delivered by [issue #87](https://github.com/secantdev/secant/issues/87). No other decision here changes.

## Amendment (2026-09-18, M3): the fourth entry point, the family arithmetic, and five M3 Operations

The "three conceptual entry points" above become **four**: [#124](https://github.com/secantdev/secant/issues/124) adds transcript reading (`readTranscript`), which
resolves a transcript `page` or `export` Resource Reference — validating Run, Session, and cursor — with no native Session id, database identity, or path crossing.

The family arithmetic is reconciled against what the closed `ProjectionSelector` actually declares. All **seven** families are built: `workspace`, `operation`,
`bundle-catalog`, `harness-catalog`, `launch-preparation`, `run`, and `run-list` (edited 2026-09-23: M3 built five, and M5 built `harness-catalog` and
`launch-preparation`). The original six of [#19](https://github.com/secantdev/secant/issues/19) were `bundle-catalog`, `harness-catalog`, `launch-preparation`,
`run-list`, `run`, and `operation`. `workspace` was the genuine addition (2026-09-09 amendment). `run-list` was already the fourth of the original six, so the
2026-09-13 amendment calling it an "eighth" family overcounted. The two catalog families are read-only and carry no Action Offers; `workspace`,
`launch-preparation`, and `run` carry them.

M3 adds **five Operations** to the closed set, as the `approve-workspace` (2026-09-09) and `cancel-run`/`delete-run` (2026-09-13) extensions each recorded theirs:
`answer-harness-request` (#117), `interrupt-turn` and `steer-turn` (#118), and `send-interactive-turn` and `end-interactive-step` (#122). This extends the #19
vocabulary; no other decision here changes.
