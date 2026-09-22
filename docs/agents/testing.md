# Testing

Read this when changing tests or fixtures.

The default suite discovers tests recursively and is deterministic: it requires no network, credentials, installed Harness, real terminal, arbitrary
sleep, or other unstable external state. Tests requiring those resources are opt-in. Tests are written against the `node:test` API and run under Bun's
test runner (`bun test`), not `bun:test`; `bunfig.toml` records why the per-test timeout is a CLI `--timeout` flag rather than a `[test] timeout` key
(that key applies only to `bun:test`, so it never reaches these tests).

## Evidence Layers

The gate separates three independently attributable, blocking layers (ADR 0027's 2026-09-21 amendment):

- The **process-free semantic suite** runs under the test runner with injected Process and Harness doubles.
- **Standalone runtime conformance** runs real Process, Git, and recorded-Harness behavior in an ordinary Bun process outside the test runner.
- **Compiled-binary acceptance** exercises Command, Harness, interruption, recovery, and Git through the copied binary in the consumer job.

The checked-in [subprocess migration ledger](../subprocess-test-migration-ledger.md) maps every legacy spawning test assertion to its replacement layer.
Its row must exist before an assertion is migrated. Migrate each row independently: after its named replacement has passed on Windows, macOS, and Linux,
remove the old subprocess assertion and mark that row `done` in the deletion change. Delete a whole old file only when all of its rows are `done`. Do not
mask a failure with a retry, sleep, timeout increase, or silent assertion removal in any layer. The issue #177 stress prototype is branch-only
investigation evidence and stays out of this tree.

The canonical test script (`scripts/test.ts`) runs four isolated file workers on every OS (`--parallel=4`). The enabler is a spawn-free semantic suite, not an
upstream Bun fix: every suite that reached a real child under the runner has moved to standalone runtime conformance — the last two, the Claude Code and Codex
Harness suites, in [#198](https://github.com/secantdev/secant/issues/198) — so no worker spawns a child at startup and the Bun 1.4.2 defect can no longer fire.
That defect was real, not a preference: on a CPU-constrained CI runner, workers each spawning a child at startup occasionally made Bun drop a child's
`exit`/`close`/stdio events entirely (the child exits, but the spawn never settles and the test times out at 30s). It first appeared on the macOS arm64 runner
([#149](https://github.com/secantdev/secant/issues/149)) and later on the ubuntu-latest runner ([#150](https://github.com/secantdev/secant/issues/150)), which
forced one worker there, and the issue #172 calibration then rejected three workers on the public `windows-latest` runner (4 logical processors and
17,174,360,064 physical-memory bytes in [run 35507654564](https://github.com/secantdev/secant/actions/runs/35507654564)) with the same spawn-lifecycle
symptoms — scattered 30 s child-process timeouts, an indeterminate Command attempt, a failed Harness schema probe. With every real-child spawn out of the suite
that cause is gone, so the count is tuned by the split-out per-step CI timing in `check.yml`: the `bun test` step is execution-bound on the Windows runner (the
tests are I/O-heavy — temp dirs and per-test SQLite — and run about ten times slower there than on Linux or macOS), and that work parallelizes, so workers are
set to the Windows runner's four logical processors and raised only while the Windows `Test` step keeps dropping, each count validated by the three-OS `check`
matrix. Isolation stays load-bearing: each file runs in its own worker, so module-level helpers and environment changes never leak across files.
Tests within each file remain sequential; do not replace file parallelism with `--concurrent`, which would race their shared fixtures. Should child-lifecycle
flakiness return, keep the spawn out of the semantic suite — never a retry, sleep, or timeout increase.

Package smoke tests copy the produced Bun compiled single-file executable out of `dist/` into an isolated temporary location and exercise it there. They
are the CI acceptance seam for headless work and do not invoke a real Harness. This is the one home for the package-smoke enumeration — the support matrix
and the `Compiled-binary smoke` step of `check.yml`'s per-OS `consumer` job point here rather than restating it. Beyond `--help`/`--version` and the no-TTY
refusal, the smoke runs on each of the three operating systems:

- The **M3 gate** ([#106](https://github.com/secantdev/secant/issues/106)): the headless Test Repair Proof Bundle Run launched from the installed binary
  against the recorded Claude Code replayer on PATH, reaching its authored Human Gate and, once answered, `succeeded` with the frozen Run `--json` fields.
- The **signal halt-then-resume** path: a Run interrupted by SIGINT mid-execution rests `halted` (POSIX aborts the live Run and leaves the claim live;
  Windows SIGINT terminates and leaves the same claim), and a later `resume` completes it.
- The **owner-death recovery** path (#86): a Run whose owner is killed by SIGKILL — uncatchable, so no handler runs and the claim is left live at a now-dead
  pid, exactly like a crash — is reconciled `halted` by a later invocation running no Step work, and a plain `resume` (no `--takeover`, because nothing is live)
  recovers it to `succeeded`, re-running no earlier Step. This is the one compiled-binary home for owner death; the process-free suite never spawns.
- **Windows `.cmd` shim** acceptance and refusal: a Command step naming an npm-style `.cmd` shim resolves through the shim, while a broken shim is refused
  at Preflight (POSIX has no shim, so it is skipped there).
- **Windows App Execution Alias** acceptance: when the runner exposes a `pwsh` or `winget` alias that `where.exe` finds after the primary PATH walk misses,
  a Command naming it passes Preflight and runs; a runner without such an alias records the reasoned gap.
- The **Matt front** refusal: the maintained interactive-agent Bundle refused headlessly with the `interactive-step-needs-tui` code and its remediation.
- **Install and collision**: building the Proof Bundle with `--no-install --output`, installing it, and rejecting a byte-different same-identity archive as
  a `bundle-identity-collision` (first-install-wins).
- **Run list and delete**: listing Previous Runs over `bundle-catalog`/`run-list`, refusing to cancel a resting Run, and deleting a Run's store.
- The **relocated pre-Drizzle home**: the checked-in pre-Drizzle fixture relocated beneath the isolated install, proving the compiled binary migrates and
  opens it through its embedded migration registries.

Verifying each shipped release channel as a consumer receives it — the archive, platform-package, npm-launcher, and installer scenarios and their CI steps
— is its own concern; see [release-consumers.md](./release-consumers.md).

Test observable behavior through the same Interface callers use. Internal refactoring should not require test rewrites. When shallow Modules are
replaced by a deeper Module, replace their implementation-coupled tests rather than retaining both suites.

Use real deterministic in-process local resources, such as temporary directories and local databases. Under the test runner, reach child-process
behavior only through the injected Process double and use an injected Adapter for remote or truly external dependencies. Real children, child-backed
Git repositories, and recorded Harness programs belong only in standalone runtime conformance or compiled-binary acceptance. Keep internal test Seams
private to the Module's Implementation.

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
- Use the injected Process double for executable resolution, commands, owned processes, cancellation, escalation, and Process-backed Git probes.
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
