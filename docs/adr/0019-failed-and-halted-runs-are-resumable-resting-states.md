# Failed And Halted Runs Are Resumable Resting States, Not Terminal Outcomes

A Crucible **Run** can stop for two unrelated reasons, and conflating them costs users work. Either the workflow **reached a verdict** and the
verdict is negative — the Test Repair Workflow burns all its **Iterations** and the test is still red, which is a real answer whose bound was the
whole point — or the workflow **never reached a verdict** because something outside its logic intervened: the Harness exhausted its quota, the
machine rebooted, the user pressed Ctrl+C. We name these `failed` and `halted` respectively, and **neither is terminal**. Both are resting states:
the Run keeps its id, keeps its **Bundle Snapshot**, **Workspace**, **Harness**, and **Run Artifacts**, and resumes from the failed **Step** with no
prior work redone. Only `succeeded` and `cancelled` end a Run, and `cancelled` is reachable only through an explicit command meaning "I am done with
this Run" — closing Crucible or pressing Ctrl+C **halts**, because a cancellation that could be resumed would just be `halted` under another name.
The two resting states still differ, but in what resume must do rather than in whether it is allowed: a `halted` Run simply continues, while
resuming a `failed` Run **resets that Step's attempt and Iteration counters to their declared bounds**. Resetting rather than granting extra on top
means resume behaves identically however many times it is invoked, and the human's decision to resume _is_ the grant. Which failures land in which
state is not this ADR's to fix: the **Harness Adapter** reports why an attempt ended and the step kind decides whether that is fatal or retryable.

We first decided the opposite — `failed` terminal, with a retry creating a **new Run** that named the failed one as its parent and inherited its
artifact bindings — and **withdrew it**, because its central argument does not hold. That argument was that reviving a Run makes "did this Run
succeed?" unanswerable. It does not: the **Step Attempt** log is append-only, so resuming appends attempts and rewrites nothing. The current state
answers "how is it now" and the log answers "what happened", and both stay truthful. Parent links and inherited bindings were dropped with it, since
they existed only to soften a restriction that no longer exists; a fresh re-run is now a plain new Run that inherits nothing, which is what a user
asking for a fresh re-run actually wants. We also rejected collapsing `failed` into `halted`, because the distinction carries information the user
needs — "the Harness ran out of quota" and "the test could not be repaired in five iterations" are not the same message — and it is exactly the
distinction that tells resume whether bounds must be reset.

The consequences are worth stating. Because a `halted` Run is resumable indefinitely but must not lock a user out of their own repository, a halted
Run **holds no Workspace claim**: the one-live-Run-per-Workspace rule covers only `running` and `blocked`. Crucible therefore does not promise a
halted Run's **Workspace** is unchanged when it resumes — other Runs may have committed and files may have moved — so resume is best-effort and
steps re-read the world when they run. And because a Run may halt on one model and resume on another, the Run pins only a _default_ model while each
**Step Attempt** records the model it actually ran under; the **Harness** itself stays pinned, since artifacts and **Harness Sessions** were produced
under it.

## Amendment — no Workspace claim (2026-09-14, ADR 0031)

[ADR 0031](./0031-own-runs-per-run-not-per-workspace.md), taken on [#102](https://github.com/secantdev/secant/issues/102) after the M2 audit,
retires the one-live-Run-per-Workspace rule this ADR restated: any number of Runs may be live in one Workspace and each live Run has exactly one
owner, held through `running` **and** `blocked`. "A halted Run holds no Workspace claim" therefore becomes the general case — no Run holds a
Workspace claim — and the consequence above stands unchanged: Crucible never promises a Run's Workspace is unchanged when it resumes, so resume is
best-effort and steps re-read the world. Where this ADR and ADR 0031 differ, ADR 0031 governs.

## Amendment — resume resets a cadence, not an Iteration bound; model and Harness are Attempt facts (M3)

Two sentences of the decision above drifted from what M3 shipped, and are corrected here:

- **There is no Iteration bound to reset.** [ADR 0020](./0020-deterministic-verdicts-and-human-checkpoints-terminate-repetition.md) removed the fixed
  iteration cap, so "resuming a `failed` Run resets that Step's attempt and Iteration counters to their declared bounds" no longer holds. Iterations
  count from absolute zero across resumes (`runRepeatGroup`): a resume replays the completed iterations by Step identity without re-running them, then
  runs fresh ones. What resume actually resets is the failed Step's **retry budget** (the Step re-attempts with its full budget) and, for a Repeat group,
  the **Review-checkpoint cadence** — a human grant buys one interval of newly-run iterations, and only newly-run iterations count toward it.
- **Neither the model nor the Harness is a Run-level pin.** The effective model and the normalized Harness identity are both **per-Attempt** facts, each
  Agent-step Attempt recording its own (#125). "The Run pins only a default model … the Harness itself stays pinned" is superseded: the Run pins neither.
