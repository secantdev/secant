# Change Review

Read this before declaring an implementation issue complete.

Record a concise, relevance-driven summary on the implementing GitHub issue. Identify only what applies:

- Owning Module and affected Interface.
- External or persisted ingress Seams.
- Behavioral test evidence meeting the completeness bar in [testing](./testing.md): the behaviors, branches, and failure paths under test, and the
  behaviors deliberately left untested and why. A reasoned gap is acceptable; a silent one is not.
- Replaced legacy behavior and deletions.
- Purpose of each new dependency.
- Guidance or ADR changes required by the work.
- Local learnings: non-obvious facts recorded in the nearest `AGENTS.md`, one to three lines each, and stale lines pruned on the way.

Omit irrelevant items. Mechanical checks remain the objective completion evidence. Use the issue until a later decision establishes another delivery
review surface.
