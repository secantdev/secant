# Engineering Baseline

This is the mandatory kernel for production engineering policy and prototype isolation policy. Root `AGENTS.md` routes each task to the focused
document that owns its rules; this file holds what every change obeys. `CONTEXT.md` owns domain vocabulary, ADRs preserve decision rationale, and
applicable local guidance may refine this baseline after its domain and seams exist. Research, historical reviews, and ignored `.agent/` files are
advisory.

## Activation

This policy is authoritative while its mechanical gate is being established. Until the Minimum Verification contract is implemented and green, only
work whose purpose is to enable this baseline may change production code or start a prototype. That bootstrap work runs every already-available check
and is complete only when the full gate passes.

## Scope

- Establish a green minimum verification gate and align runtime declarations, types, build targets, dependencies, and verification environments before
  Crucible coding or prototype work begins.
- Apply structural standards as a quality ratchet to new production code and to legacy code whose seam a change crosses.
- Leave untouched legacy code alone unless current work depends on changing it.
- Unused is not dead. In a project still being built, declared surface (exports, Interface members, vendored helpers, ADR-named contracts) awaits
  its callers. Delete only what a decision, a ticket, or a retired consumer names, never because a search found no importer.
- Apply the lightweight prototype contract; other focused rules apply only when a prototype crosses their explicit trigger.

## Architecture-Independent Rules

A rule belongs in this baseline only when it remains valid if the domain topology, package layout, runtime, libraries, test framework, or presentation
technology changes.

State cross-cutting outcomes here, including ownership, dependency discipline, runtime alignment, and testing through a Module's Interface. Defer
concrete owners, dependency arrows, versions, tools, paths, and topology until the decisions that establish their seams exist.

## Minimum Verification

The repository must expose one canonical check entrypoint covering:

- Type and static checking.
- Formatting verification.
- Linting.
- Recursively discovered deterministic tests.
- The production build.
- Installation and packaged-entrypoint smoke testing of the produced package, covering `--help`/`--version` and the headless commands a slice lands.
- Narrow structural checks when a settled, high-cost rule becomes mechanically enforceable, including the import-boundary and guidance-structure
  suites under `tests/architecture/`.

CI must perform a clean dependency installation before running the check entrypoint. Tests that require an installed Harness, network access,
credentials, or a real terminal remain opt-in. External URL validation, coverage thresholds, and a general architecture linter are not part of the
baseline.
