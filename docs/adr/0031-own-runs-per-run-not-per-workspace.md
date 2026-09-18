# Own Runs per Run, Not per Workspace

Crucible allows **any number of live Runs in one Workspace**, from the same or different Bundles, and owns each of them separately: a live **Run**
has exactly one **Run owner**, and a second Secant instance is refused for that Run only, never for the Workspace. The previous rule — one live
Run (`running` or `blocked`) per Workspace, held as a Workspace claim in `coordination.db` and backed by a partial unique index — was fixed in
[#4](https://github.com/secantdev/secant/issues/4) for one recorded reason: "two Runs editing one repository would have each one's Git steps
observing the other's half-finished work". [#14](https://github.com/secantdev/secant/issues/14) then removed Git Steps from the product, so the
reason names nothing that exists, and [#21](https://github.com/secantdev/secant/issues/21) had already scoped cross-process refusal to the single
Run ("a Run live in another process refuses to open"). The [M2 audit](https://github.com/secantdev/secant/issues/94) found the shipped code
releasing the claim on `blocked` and resting a Run live in another process as dead, and the grilling on
[#102](https://github.com/secantdev/secant/issues/102) (2026-09-14) resolved the divergence by replacing the rule rather than enforcing it harder:
Secant enables rather than restricts, and OpenCode — the practice baseline — runs many live sessions per process with no per-directory lock.
Workspace collisions between Runs are the user's, exactly as collisions between a Run and a user's own edits already are; the **Materialization
conflict** stays the only detection and covers only `home: workspace` Artifacts.

Ownership is a per-Run record, not a Workspace fact. The `runs` registration in `coordination.db` carries a nullable owning process id and the
monotonic fencing epoch; `NULL` means unowned, and the former `state` column and the `one_live_run` index are deleted. Ownership lasts from
acquisition until the Run rests — **including through `blocked`**, so a Review checkpoint is answered in the instance that reached it. Whoever
opens a Workspace group performs the bookkeeping for every owned Run by probing its process: an alive owner leaves the Run live, listed as live
elsewhere, and refused to open with the owner named ([#21](https://github.com/secantdev/secant/issues/21)); a dead owner rests the Run — a
`running` Run becomes `halted` with the `indeterminate` marker as before, while a `blocked` Run **stays `blocked`** with its ownership
released, because nothing was cut off and the pending gate is still true. Fencing, not the probe, is what makes ownership safe: acquiring a
Run bumps the epoch and a stale owner's next canonical write is refused, so **taking over** a Run whose owner appears alive is offered behind one
confirmation naming that owner, and the probe is only a courtesy against accidental takeover and process-id reuse.

One instance may run several Runs at once. A Run keeps running when the user leaves its Workbench, launching while other Runs are live is not
gated or prompted, Previous Runs marks live Runs and follows their durable updates, the Workbench header says whether a Run is live in this instance
or another, and quitting halts every running Run after one confirmation naming the count, while a blocked Run keeps its rest and releases ownership. Rejected: keeping the claim as an advisory launch warning (a
gate under another name), releasing ownership on `blocked` (ownership split by state that the Workbench would have to explain), and read-only
cross-instance observation (still the future version [#21](https://github.com/secantdev/secant/issues/21) parked; observe and own remain one
fencing operation). This supersedes the one-live-Run sentences of [ADR 0019](./0019-failed-and-halted-runs-are-resumable-resting-states.md) and
[ADR 0023](./0023-own-durable-run-truth-in-isolated-run-stores.md), both amended to point here; the rest of ADR 0023 — isolated Run Stores,
owner fencing, startup recovery that starts no Step work, coordinator rebuild with no owner — is unchanged.

## Amendment (M3 tidy, [#129](https://github.com/secantdev/secant/issues/129))

- **Quitting a blocked Run (A21).** The body originally had quitting halt every live Run without exception. Corrected: quitting halts every **running** Run; a
  **blocked** Run keeps its rest and releases ownership. The old wording contradicted this ADR's own reconciliation rule — where a dead owner leaves a
  blocked Run blocked, never halted — and [ADR 0023](./0023-own-durable-run-truth-in-isolated-run-stores.md)'s durable gates, which a shutdown must not
  discard. Halting a blocked Run would throw away a pause the human still has to answer.
- **`blocked` is durable, not computed (A63).** The body originally described `blocked` as computed from the current Step Attempt rather than stored.
  Since [#108](https://github.com/secantdev/secant/issues/108) the authored Human Gate's `pending_gate` row and the `blocked` state are written in one
  transaction, so `blocked` is durable truth a crash cannot lose; the checkpoint facts a Review checkpoint shows are still projected from the attempt log,
  but the state itself is stored.
