# Testing

Read this when changing tests or fixtures.

The default suite discovers tests recursively and is deterministic: it requires no network, credentials, installed Harness, real terminal, arbitrary
sleep, or other unstable external state. Tests requiring those resources are opt-in. Tests are written against the `node:test` API and run under Bun's
test runner (`bun test`), not `bun:test`; `bunfig.toml` records why the per-test timeout is a CLI `--timeout` flag rather than a `[test] timeout` key
(that key applies only to `bun:test`, so it never reaches these tests).

The canonical test script (`scripts/test.ts`) runs isolated file workers — two on Windows, but one on macOS and Linux (`--parallel=1`). Isolation is
load-bearing: module-level helpers and environment changes must not leak across files, and every OS keeps it (one worker per file, just not concurrent on
macOS or Linux). Tests within each file remain sequential; do not replace file parallelism with `--concurrent`, which would race their shared fixtures. The
serialization works around a Bun 1.4.2 defect, not a preference: on a CPU-constrained CI runner, two workers each spawning a child at
startup occasionally make Bun drop a child's `exit`/`close`/stdio events entirely (the child exits, but the spawn never settles and the test times out at
30s). It first appeared on the macOS arm64 runner ([#149](https://github.com/secantdev/secant/issues/149)) and later on the ubuntu-latest runner
([#150](https://github.com/secantdev/secant/issues/150)), so both are serialized. The launcher documents it in full; restore `--parallel=2` on macOS and
Linux when Bun fixes child-process lifecycle delivery under load.

Package smoke tests copy the produced Bun compiled single-file executable out of `dist/` into an isolated temporary location and exercise it there. They
are the CI acceptance seam for headless work and do not invoke a real Harness. This is the one home for the package-smoke enumeration — the support matrix
and the `check.yml` `smoke` job point here rather than restating it. Beyond `--help`/`--version` and the no-TTY refusal, the smoke runs, on each of the
three operating systems:

- The **M3 gate** ([#106](https://github.com/secantdev/secant/issues/106)): the headless Test Repair Proof Bundle Run launched from the installed binary
  against the recorded Claude Code replayer on PATH, reaching its authored Human Gate and, once answered, `succeeded` with the frozen Run `--json` fields.
- The **signal halt-then-resume** path: a Run interrupted by SIGINT mid-execution rests `halted` (POSIX aborts the live Run and leaves the claim live;
  Windows SIGINT terminates and leaves the same claim), and a later `resume` completes it.
- **Windows `.cmd` shim** acceptance and refusal: a Command step naming an npm-style `.cmd` shim resolves through the shim, while a broken shim is refused
  at Preflight (POSIX has no shim, so it is skipped there).
- The **Matt front** refusal: the maintained interactive-agent Bundle refused headlessly with the `interactive-step-needs-tui` code and its remediation.
- **Install and collision**: building the Proof Bundle with `--no-install --output`, installing it, and rejecting a byte-different same-identity archive as
  a `bundle-identity-collision` (first-install-wins).
- **Run list and delete**: listing Previous Runs over `bundle-catalog`/`run-list`, refusing to cancel a resting Run, and deleting a Run's store.
- The **relocated pre-Drizzle home**: the checked-in pre-Drizzle fixture relocated beneath the isolated install, proving the compiled binary migrates and
  opens it through its embedded migration registries.

## Release Archive Consumer

Separate from the package smoke, the `release-archive-consumer` job ([check.yml](../../.github/workflows/check.yml)) verifies the assembled release
archives (`scripts/assemble.ts`, #150) as a consumer receives them. Assembly runs once on the Linux `build` job from the just-built candidate bytes
through the one target manifest (`scripts/targets.ts`), emitting the three archives, a candidate manifest, and `SHA256SUMS`; it never rebuilds an input
and fails closed on any identity/version/digest disagreement. On the Windows x64, macOS arm64, and Linux x64 matrix, `scripts/release-consumer.ts`
extracts the matching archive and proves layout, executable mode, inner-binary digest, bundled `LICENSE`/`THIRD-PARTY-NOTICES.md`, native execution and
version, and — on macOS — the strict ad-hoc signature. `tests/release/assemble.test.ts` unit-tests the pure logic — manifest facts and digests
(`computeCandidate`), the immutability/identity/version/digest checks (`assertAgrees`), and the consumer's pre-extraction refusals — and spawns no
subprocess: creating or extracting real archives there would add a concurrent first-spawn worker that tips over the Bun 1.4.2 child-lifecycle defect on
the constrained Linux runner (#149). The archive create → extract → run round-trip on real binaries is therefore proven only by this CI job, the way
the compiled-binary smoke lives outside `bun test`.

## Platform Package Consumer

The `platform-package-consumer` job ([check.yml](../../.github/workflows/check.yml)) verifies the three per-platform npm packages (`scripts/pack.ts`,
#151) as an npm consumer receives them. Packing runs once on the Linux `build` job after assembly: `scripts/pack.ts` reads the archive candidate manifest
(`scripts/assemble.ts`), fails closed unless every dist binary and the legal material are byte-identical to that candidate, and emits one exact-version,
os/cpu-constrained npm tarball per target (built with `bun pm pack`, so the npm channel needs no Node toolchain) plus a `package-manifest.json`. Each
package carries only its executable, `LICENSE`, and `THIRD-PARTY-NOTICES.md`, with no lifecycle script. On the Windows x64, macOS arm64, and Linux x64
matrix, `scripts/package-consumer.ts` installs the matching package with `npm install --ignore-scripts` (npm is the channel under test) and proves its
os/cpu constraint, exact version, contents, the absence of a lifecycle script, inner-binary digest against the archive candidate, executable mode, native
execution and version, and — on macOS — the strict ad-hoc signature. `tests/release/pack.test.ts` unit-tests the pure logic — the package.json shape
(`platformPackageJson`), the byte-identity anchoring to the archive candidate (`computePackages`), the immutability/identity/version/digest checks
(`assertPackagesAgree`), the consumer's pre-install refusals (unknown target, wrong host, tampered/missing/malformed manifest), and its installed-contents
refusals against a hand-staged directory (stale version, lifecycle script, unexpected/missing/tampered files, inner-binary digest, executable mode via
`verifyInstalledPackage`) — and spawns no subprocess, for the same Bun 1.4.2 child-lifecycle reason (#149). Only the `bun pm pack` → `npm install` → run
round-trip on real binaries (npm's own os/cpu gating, mode preservation, native execution, macOS signature) is left to this CI job.

## PowerShell Installer Consumer

The separate `powershell-installer-consumer` job ([check.yml](../../.github/workflows/check.yml)) supplies the assembled
candidate through a network-free local-candidate seam. The macOS arm64 and Linux x64 legs exercise native unsupported-target
detection before candidate access. The Windows x64 leg installs into an isolated home, runs the installed executable,
exercises latest and exact versions, executes the declined PATH instruction twice, and checks idempotent default PATH changes.
It preserves the installed bytes across missing input, malformed manifest/version, target-identity, checksum, layout,
inner-binary, legal-material, and executable-version failures. The scenario invokes native PowerShell and the standalone
candidate only; it requires no Git Bash, Node, Bun, credentials, or network. A directory-swap failure is deliberately not
induced: doing so deterministically would require a private installer hook or an inherently racy Windows file lock.

## POSIX Installer Consumer

The `posix-installer-consumer` job ([check.yml](../../.github/workflows/check.yml)) gives root `install.sh` the local candidate without a product runtime.
macOS arm64 and Linux x64 install under fixed `~/.secant/bin` in isolated homes and retain the declined-PATH instruction; macOS pins Terminal guidance.
Windows x64 and the source suite there prove only refusal before candidate access. On POSIX, `tests/release/posix-installer.test.ts` also covers
target/identity, checksum/layout/version/legal refusal, failed-update preservation, `SECANT_HOME` independence, latest/exact versions, and PATH changes.

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
