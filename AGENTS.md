# Agent Instructions

Read the line that matches your task, then the file it names. The canonical gate (`bun run check`) is the safety net; these lines are the route.

## Tracker and domain

- Before reading or changing an issue or spec, follow `docs/agents/issue-tracker.md`.
- Before applying or interpreting triage labels, follow `docs/agents/triage-labels.md`.
- Before opening or closing a milestone, gate, or spec issue, follow `docs/agents/milestones.md`.
- Before creating, running, or closing a Milestone audit, follow `docs/agents/milestone-audit.md`.
- Before shaping a spec or cutting it into slices, follow `docs/agents/slicing.md`.
- Before exploring or changing a domain area, follow `docs/agents/domain.md`.

## Engineering

- Before changing source, tests, dependencies, tooling, or prototypes, follow `docs/agents/engineering-baseline.md`.
- Before changing ownership, a Module, its Interface, or a Seam, read `docs/agents/module-design.md`.
- Before creating or moving target source, changing a public entrypoint, or crossing a Module, read `docs/agents/topology.md`.
- Before changing dependencies, composition, or allowed import direction, read `docs/agents/dependencies.md`.
- Before changing tests or fixtures, read `docs/agents/testing.md`.
- Before changing `scripts/package-smoke.ts` or a compiled-binary smoke scenario, read `docs/agents/package-smoke.md`.
- Before changing the private internals of the Claude Code or Codex Harness Adapter, read `docs/agents/harness-adapters.md`.
- Before changing live Run control (deferred settlement, interrupt, steer, cancel, shutdown, takeover, interactive-Step drive, or the live overlay),
  read `docs/agents/run-control.md`.
- Before changing the Run Workbench's key routing, modal stack, steer compose, interactive input, destructive confirms, or details panel, read
  `docs/agents/tui-workbench.md`.
- Before changing a release-channel consumer scenario (archive, platform package, npm launcher, or installer), the release legal-closure gate, or
  their CI steps, read `docs/agents/release-consumers.md`.
- Before changing release-workflow policy (candidate validation, tag admission, the `release-gate.ts` approval summary, protected promotion) or its CI
  jobs, read `docs/agents/release-workflow.md`.
- Before handling external or persisted input or translating external failures, read `docs/agents/validation.md`.
- Before starting or changing a prototype, read `docs/agents/prototypes.md`.
- Before replacing or deleting existing behavior or a compatibility layer, read `docs/agents/refactoring.md`.
- Before adding, moving, splitting, or materially expanding agent guidance, read `docs/agents/guidance.md`.
- Before declaring an implementation issue complete, read `docs/agents/change-review.md`.

## Module-local guidance

Before editing under a Module root that carries its own `AGENTS.md`, read that file. Each one is listed here by path when it is created:

- `src/application/AGENTS.md` — Application Module: observed-owner writes, gate answering, Trust-grant order, launch and Harness selection, live-Run reads, derived state.
- `src/headless/AGENTS.md` — headless CLI Module: the exit-code contract, gate re-read, frozen `--json` shapes, and commander-settings ordering.
- `src/tui/AGENTS.md` — presentation Module: OpenTUI layout and key-binding invariants, the Renderer Port rule, and the per-screen view seams for screen authors.
- `src/bundle/AGENTS.md` — Bundle Module: digest, validator, and budget invariants for slice authors.
- `src/run/store/AGENTS.md` — Run Store Module: coordination/run.db split, crash-safety ordering, and fencing invariants for slice authors.
- `src/harness/AGENTS.md` — Harness Module: Interface opacity, terminal ordering, typed-failure/throw split, and durable-admission invariants.
- `src/process/AGENTS.md` — process Module: the Process Interface, Windows `escalated` (true for a live child, false once gone), the shared-bound shutdown, git spawns.
- `src/composition/AGENTS.md` — composition Module: Adapter opacity above the root and sole Harness-registry ownership.
- `src/run/execution/AGENTS.md` — Run execution Module: abort-reason to resting-state mapping, the three admitted Turn writes, Agent evidence, Command-step Git hardening.
- `src/catalog/AGENTS.md` — Catalog Module: first-install-wins, generation-keyed Trust grants, lock-free re-extraction, and the asset-root Interface crossing.

## Commits

No Co-author in commit messages.
