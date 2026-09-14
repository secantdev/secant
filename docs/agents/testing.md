# Testing

Read this when changing tests or fixtures.

The default suite discovers tests recursively and is deterministic: it requires no network, credentials, installed Harness, real terminal, arbitrary
sleep, or other unstable external state. Tests requiring those resources are opt-in. Tests are written against the `node:test` API and run under Bun's
test runner (`bun test`), not `bun:test`; `bunfig.toml` records why the per-test timeout is a CLI `--timeout` flag rather than a `[test] timeout` key
(that key applies only to `bun:test`, so it never reaches these tests).

Package smoke tests install the produced artefact in an isolated temporary location and exercise its entrypoint: the Bun compiled single-file
executable is copied out of `dist/` and run there. It covers far more than `--help`/`--version` now — approving a Workspace under a temporary
`SECANT_HOME` and reading it back with `--json`, building a Proof Bundle, launching Runs that reach `succeeded`, that halt on a materialization
conflict, and that pause at a Human Gate for an answer, plus the no-interactive-terminal and `git-worktree-root` refusals. They are the CI acceptance
seam for headless work and do not invoke a real Harness.

Test observable behavior through the same Interface callers use. Internal refactoring should not require test rewrites. When shallow Modules are
replaced by a deeper Module, replace their implementation-coupled tests rather than retaining both suites.

Use real deterministic local resources, such as temporary directories and Git repositories. Use an injected Adapter for remote or truly external
dependencies, and keep internal test Seams private to the Module's Implementation.

## Behavioral Completeness

Tests are the Module's executable specification. Cover every promised behavior, branch, and failure path — not every input permutation — and each
boundary where bugs cluster (empty, zero, maximum, first and last, absent). The bar: a plausible wrong edit to the logic must turn some test red, so
assert the consequence (the value, state, or output), never that code merely ran. Depth scales with blast radius — money, security, data-loss, and
validation paths carry the most, trivial glue a line; never test the framework or the compiler. Completeness is defensible, not total: name the
behaviors you deliberately leave untested and why. A silent gap is the failure; a reasoned one is not. A flaky test is not a net — if a behavior
cannot be asserted deterministically, that is a named gap, not a sleep or a retry.

## Fixture Ladder

- Test in-process behavior with ordinary real values.
- Use deterministic real substitutes for local resources.
- Use injected Adapters for remote or third-party Seams.
- Give recorded external-protocol fixtures source and version provenance, redaction, representative data, and update instructions.
- When replacing a recording, explain meaningful behavioral or protocol changes on the implementing issue.
- Await observable readiness events, promises, probes, or bounded conditions instead of fixed sleeps.

## Release Evidence

The canonical gate runs on Windows, macOS, and Linux, and a release publishes only from CI behind a human-approved environment. Real-terminal and
real-Harness evidence that CI cannot produce is recorded per release; see [ADR 0027](../adr/0027-gate-releases-on-three-os-ci-and-recorded-human-evidence.md).

## Recorded Harness Fixtures

- Recordings live under `tests/harness/fixtures/<harness>/<case>/` and stay byte-faithful; their metadata lives beside them in `recording.json`.
- `recording.json` names `harness`, `executableVersion`, `protocolVersion`, `recordedAt`, `redactions`, and `refreshCommand`. The guidance-structure
  suite fails a case directory without it.
- Refresh is an opt-in script that needs the installed Harness. An agent or a human may re-record; the implementing issue states what changed
  semantically.
