# Change Review

Read this before declaring an implementation issue complete.

Record a concise, relevance-driven summary on the implementing GitHub issue. Identify only what applies:

- Owning Module and affected Interface.
- External or persisted ingress Seams.
- Behavioral test evidence meeting the completeness bar in [testing](./testing.md): the behaviors, branches, and failure paths under test, and the
  behaviors deliberately left untested and why. A reasoned gap is acceptable; a silent one is not.
- Replaced legacy behavior and deletions.
- Purpose of each new dependency.
- UPSTREAM currency: when the work copies from or rebuilds a component against OpenCode, record it in `UPSTREAM` (what was taken, what was changed) per
  ADR 0018. No gate follows this, so the record is only current if the review updates it.
- Guidance or ADR changes required by the work.
- Local learnings: non-obvious facts recorded in the nearest `AGENTS.md`, one to three lines each, and stale lines pruned on the way.

Omit irrelevant items. Mechanical checks remain the objective completion evidence.
Before considering the implementation complete, finish the downstream closure bookkeeping in [issue tracker](./issue-tracker.md); if it was the
milestone's final implementation ticket, follow [milestones](./milestones.md).
