# Testing

Read this when changing tests or fixtures.

The default suite discovers tests recursively and is deterministic: it requires no network, credentials, installed Harness, real terminal, arbitrary
sleep, or other unstable external state. Tests requiring those resources are opt-in. Tests are written against the `node:test` API and run under Bun's
test runner (`bun test`), not `bun:test`; `bunfig.toml` records why the per-test timeout is a CLI `--timeout` flag rather than a `[test] timeout` key
(that key applies only to `bun:test`, so it never reaches these tests).

The canonical test script (`scripts/test.ts`) runs isolated file workers — two on Windows, but one on macOS and Linux (`--parallel=1`). Windows is capped
at two after the issue #172 calibration: its public `windows-latest` runner has a documented 4 vCPUs and 16 GB RAM, and reported 4 logical processors and
17,174,360,064 physical-memory bytes in [run 35507654564](https://github.com/secantdev/secant/actions/runs/35507654564), but three workers produced
scattered 30 s child-process timeouts, an indeterminate Command attempt, and a failed Harness schema probe. Per the no-retry protocol, that first failure
rejected three workers, so four was not tried. Isolation is load-bearing: module-level helpers and environment changes must not leak across files, and
every OS keeps it (one worker per file, just not concurrent on macOS or Linux). Tests within each file remain sequential; do not replace file parallelism
with `--concurrent`, which would race their shared fixtures. The serialization works around a Bun 1.4.2 defect, not a preference: on a CPU-constrained CI
runner, two workers each spawning a child at startup occasionally make Bun drop a child's `exit`/`close`/stdio events entirely (the child exits, but the
spawn never settles and the test times out at
30s). It first appeared on the macOS arm64 runner ([#149](https://github.com/secantdev/secant/issues/149)) and later on the ubuntu-latest runner
([#150](https://github.com/secantdev/secant/issues/150)), so both are serialized. The launcher documents it in full; restore `--parallel=2` on macOS and
Linux when Bun fixes child-process lifecycle delivery under load.

Package smoke tests copy the produced Bun compiled single-file executable out of `dist/` into an isolated temporary location and exercise it there. They
are the CI acceptance seam for headless work and do not invoke a real Harness. This is the one home for the package-smoke enumeration — the support matrix
and the `Compiled-binary smoke` step of `check.yml`'s per-OS `consumer` job point here rather than restating it. Beyond `--help`/`--version` and the no-TTY
refusal, the smoke runs on each of the three operating systems:

- The **M3 gate** ([#106](https://github.com/secantdev/secant/issues/106)): the headless Test Repair Proof Bundle Run launched from the installed binary
  against the recorded Claude Code replayer on PATH, reaching its authored Human Gate and, once answered, `succeeded` with the frozen Run `--json` fields.
- The **signal halt-then-resume** path: a Run interrupted by SIGINT mid-execution rests `halted` (POSIX aborts the live Run and leaves the claim live;
  Windows SIGINT terminates and leaves the same claim), and a later `resume` completes it.
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
