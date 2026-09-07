# Deterministic Verdicts And Human Checkpoints Terminate Workflow Repetition

A Crucible **Repeat group** ends when a named **Verdict** artifact reads `pass`, and never because an agent said so. This rests on a split that is
easy to miss and expensive to get wrong: a **Command step**'s exit status is a _value_, not an _attempt outcome_. The attempt **succeeds if the
command ran to an exit**, writing a `pass`/`fail` **Verdict** plus a `text` artifact holding the captured output, and it fails only when the command
could not execute at all — a missing binary, a timeout. Conflating the two breaks the **Test Repair Workflow** at its very first step, because a
failing test is that workflow's _expected input_ rather than a step failure: under the conflation the baseline test run would consume the retry
budget and fail the **Run** before the fixing agent ever saw the problem. The loop condition names the **Verdict** rather than a **Step**, and is
evaluated **before every iteration including the first**. Because artifact names rebind per **Step Attempt**, a step outside the group binds the
verdict before the group is entered, so an already-green test runs zero iterations and goes straight to its **Human Gate** instead of having an agent
"fix" passing code. Naming a Step cannot express this, since the baseline run and the in-loop run are necessarily distinct **Step** ids and the named
one has no attempt to read before the first iteration.

This **retires the agent-emitted terminal marker of [ADR 0010](./0010-devflow-owned-dumb-execution-loop.md)**. That marker existed only because the
legacy implementation had no deterministic step kind to carry the question, and ADR 0010 already names the absolute empty-directory check as an
honest signal. Expressed as a **Routing**, the legacy execution loop becomes `[check issues remain] → repeat { [agent iteration, fresh session] →
[check issues remain] } until drained`: the `no-file` exit becomes the zero-iteration case, and the per-iteration marker becomes an agent step
ending its turn. A **queue** therefore needs no representation in the runtime at all — it is an artifact plus a Command step — and no queue or list
step kind is introduced. We rejected letting a Bundle _choose_ between a marker and a verdict. Once the deterministic form exists the marker has no
remaining job, and permitting both would leave a door through which a future workflow's logic re-enters the runtime through the agent's mouth,
which is exactly what Crucible orchestrating _around_ the Harness forbids. The same reasoning ends an **Interactive agent step** on an explicit
human control rather than on a marker or a recognised phrase: Crucible must never read meaning out of a turn.

ADR 0010's fixed cap of `2N + 5` iterations is replaced by a **Review checkpoint** (named Iteration checkpoint before the
[#13 amendment](https://github.com/DevFlow-HQ/devflow-cli/issues/13#issuecomment-5528817597)), and **no Bundle declares any iteration bound**. A workflow is
problem-agnostic — one **Routing** serves "repair a single function" and "build the whole application" — so an author cannot know how many
iterations are enough, and the goal was never to choose a maximum but to make unattended repetition stop for review. Every Repeat group instead
declares a required positive-integer review interval and plain-text message. When that cadence is reached without the verdict passing, the group
raises a **Human Gate** with the authored message plus Crucible-owned runtime evidence: continuing grants another interval and stopping ends the Run
`failed`. The cadence is authored workflow guidance, not a maximum or a launch-time control, and Crucible enforces an engine-owned safety ceiling so
a Bundle cannot effectively disable review. A Run resting `blocked` costs nothing and can wait indefinitely, so this guarantees human checkpoints
without failing a legitimate long Run because someone guessed a maximum. The cap was only ever a runaway guard; the drained-queue verdict was
always the honest exit. **Retries** are bounded differently and deliberately so: they measure transient flakiness rather than problem size, so the
step kind decides what is retryable at all, Crucible sets the default budget, and a **Workflow Bundle** may optionally override it. A bound that reads
an artifact — the literal expression of `2N + 5` — was rejected as the beginning of the workflow expression language this design exists to avoid.
