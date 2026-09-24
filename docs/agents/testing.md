# Testing

Read this when changing tests or fixtures.

The default suite discovers tests recursively and is deterministic: it requires no network, credentials, installed Harness, real terminal, arbitrary
sleep, or other unstable external state. Tests requiring those resources are opt-in. Tests are written against the `node:test` API and run under Bun's
test runner (`bun test`), not `bun:test`; `bunfig.toml` records why the per-test timeout is a CLI `--timeout` flag rather than a `[test] timeout` key
(that key applies only to `bun:test`, so it never reaches these tests).

## Evidence Layers

The gate separates three independently attributable, blocking layers (ADR 0027's 2026-09-21 amendment):

- The **process-free semantic suite** runs under the test runner with injected Process and Harness doubles; the scripted Process is
  `tests/process/fake-adapter.ts`.
- **Standalone runtime conformance** runs real Process, Git, and recorded-Harness behavior in an ordinary Bun process outside the test runner: the
  `tests/process/runtime-conformance.ts` program, run by `bun run test:runtime-conformance` and CI's `Process runtime conformance` step. It and the
  terminal-lifecycle program share their runner helpers (timeouts, exit, temp-dir cleanup) in `tests/helpers/standalone.ts`.
- **Compiled-binary acceptance** exercises Command, Harness, interruption, recovery, and Git through the copied binary in the consumer job.

The checked-in [subprocess migration ledger](../subprocess-test-migration-ledger.md) is complete: every row is `done` and stays as a historical coverage
record. A new real-spawn assertion goes straight to standalone runtime conformance or compiled-binary acceptance, never into the semantic suite. Do not
mask a failure with a retry, sleep, timeout increase, or silent assertion removal in any layer.

The canonical test script (`scripts/test.ts`) runs three isolated file workers on every OS (`--parallel=3`). Three is safe only because no worker spawns a
child: under the Bun 1.4.2 child-lifecycle defect ([#149](https://github.com/secantdev/secant/issues/149)), workers each spawning a child at startup on a
CPU-constrained runner occasionally lost the child's `exit`/`close`/stdio events, and the spawn never settled. The count is tuned by the per-step CI timing
in `check.yml`: the Windows `bun test` step is disk-I/O-bound, so parallelism plateaus near three and more workers buy nothing. Isolation stays
load-bearing: each file runs in its own worker, so module-level helpers and environment changes never leak across files. Tests within each file remain
sequential; do not replace file parallelism with `--concurrent`, which would race their shared fixtures. Should child-lifecycle flakiness return, keep
the spawn out of the semantic suite — never a retry, sleep, or timeout increase.

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
- **Shipped Bundles embedded**: this OS's binary rebuilds each allow-listed folder to its `bundles/builtin.lock.json` digest and embeds those exact bytes,
  and not the External Proof Bundle's.
- **Shipped Bundles startup** (#227): a fresh home's first startup installs exactly the locked built-ins with origin `built-in` and app-release trust, a
  second startup changes no Catalog row, a byte-different import collides naming the built-in, another version installs beside it, and a home whose
  built-in identity is already held (seeded through the source CLI) gets a stderr notice while the command succeeds.
- The **Matt front** refusal: the built-in the startup ensure installed, refused headlessly with the `interactive-step-needs-tui` code and its remediation.
- **launch-preparation-headless** (#189): a not-ready draft (missing input, untrusted digest) `run launch` prints in full (text and JSON), exiting one and creating no Run.
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
