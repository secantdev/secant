# Guidance Design

Read this before adding, moving, splitting, or materially expanding agent guidance. Decided in
[Define Crucible's progressive engineering guidance and quality ratchet](https://github.com/DevFlow-HQ/devflow-cli/issues/25); Harness loading
mechanics and reliability evidence are in [agent-guidance progressive disclosure](../research/agent-guidance-progressive-disclosure.md).

## Shape

- Root `AGENTS.md` is the always-loaded index: one trigger line per focused document and per Module-local `AGENTS.md`. Its only rules of its own are
  the short always-on `## Commits` convention every commit needs in context; everything else routes to a focused document.
- `CLAUDE.md` is a one-line `@AGENTS.md` import, never a symlink. Git checks symlinks out as plain text wherever `core.symlinks` is off, which is
  the common Windows result.
- `engineering-baseline.md` is the mandatory kernel. Each focused document under `docs/agents/` owns one concern and may point deeper.
- Prose pointers are model-triggered guidance; the canonical gate is the safety net. A rule whose violation is costly and mechanically detectable
  becomes a narrow check rather than more prose.
- Code style lives in `eslint`, `prettier`, and `tsconfig` configuration, not prose. Prose states only what a linter cannot express.
- `CONTRIBUTING.md` is for people: setup, verification, and pull-request expectations. Agents never load it, and it duplicates no policy.
- Task workflows belong to the skills the developer already runs. The repository defines a skill only after one workflow has repeated three times
  and its ticket packet cannot carry it.

## Module-local `AGENTS.md`

- Lives only at a Module root declared in the [policy table](../../tests/architecture/module-policy.ts), created by the first slice that records a
  non-obvious local fact. Nothing is pre-seeded.
- Claude Code and OpenCode load it when a file under it is read. Codex CLI loads only the `AGENTS.md` chain from repository root to its working
  directory, and every Harness is launched from the root, so root `AGENTS.md` lists every Module-local file by path. The check enforces the listing.
- Sections in fixed order, only filled ones present: Owns, Never owns, Invariants, Tests, Read next. Ownership and import direction are read from
  the topology and policy table, never restated.
- Inherits the baseline, adds only local facts, and cannot weaken any rule.

## Limits

The guidance-structure suite under `tests/architecture/` enforces:

- Root `AGENTS.md` at most 60 lines. Focused documents and Module-local `AGENTS.md` trigger a split review at 80–100 lines and fail at 120.
- Agent-facing prose in `AGENTS.md`, `docs/agents/`, `CONTEXT.md`, and `docs/glossary/` wraps at 175 characters. Lines carrying a URL, Markdown
  table rows, and code fences are exempt.
- Every relative link in those files plus `docs/adr/` and `docs/research/` resolves; every backticked `.md` path in `AGENTS.md` and `docs/agents/`
  resolves.
- Every Module-local `AGENTS.md` sits at a declared Module root and is listed in root `AGENTS.md`.
- Every recorded Harness fixture directory carries its `recording.json` sidecar; see [testing](./testing.md).

## Maintenance

- Before closing an issue, record non-obvious local learnings in the nearest `AGENTS.md`, one to three lines each, and prune stale lines passed on
  the way; [change review](./change-review.md) carries the trigger.
- Adding, moving, splitting, or materially expanding guidance triggers a one-shot review: follow the affected pointer chain once with a
  representative task and confirm it reaches every required rule without loading unrelated branches.
- At each refactoring gate the sequencing decision defines, walk the full tree once for relevance and run one representative task per Harness
  (Claude Code, Codex CLI, OpenCode), checking the transcript for whether the pointed-at documents were read. No automated pointer eval.
- Every rule has one authoritative home. Unresolved topology-, runtime-, and domain-specific decisions stay in their wayfinding issues. When a
  decision establishes a real Seam, add the smallest focused guidance and a narrow check before implementation crosses it.
