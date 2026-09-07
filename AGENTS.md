# Agent Instructions

Read the line that matches your task, then the file it names. The canonical gate (`npm run check`) is the safety net; these lines are the route.

## Tracker and domain

- Before reading or changing an issue or spec, follow `docs/agents/issue-tracker.md`.
- Before applying or interpreting triage labels, follow `docs/agents/triage-labels.md`.
- Before opening or closing a milestone, gate, or spec issue, follow `docs/agents/milestones.md`.
- Before exploring or changing a domain area, follow `docs/agents/domain.md`.

## Engineering

- Before changing source, tests, dependencies, tooling, or prototypes, follow `docs/agents/engineering-baseline.md`.
- Before changing ownership, a Module, its Interface, or a Seam, read `docs/agents/module-design.md`.
- Before creating or moving target source, changing a public entrypoint, or crossing a Module, read `docs/agents/topology.md`.
- Before changing dependencies, composition, or allowed import direction, read `docs/agents/dependencies.md`.
- Before changing tests or fixtures, read `docs/agents/testing.md`.
- Before handling external or persisted input or translating external failures, read `docs/agents/validation.md`.
- Before starting or changing a prototype, read `docs/agents/prototypes.md`.
- Before replacing legacy behavior, read `docs/agents/refactoring.md`.
- Before adding, moving, splitting, or materially expanding agent guidance, read `docs/agents/guidance.md`.
- Before declaring an implementation issue complete, read `docs/agents/change-review.md`.

## Module-local guidance

Before editing under a Module root that carries its own `AGENTS.md`, read that file. Each one is listed here by path when it is created:

- None yet.

## Commits

No Co-author in commit messages.
