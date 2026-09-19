# Release-Channel Consumer Verification

Read this before changing a release-channel consumer scenario — the archive, platform-package, npm-launcher, or installer jobs — or the scripts and CI
they run through.

Each shipped release channel is verified on the Windows x64, macOS arm64, and Linux x64 matrix (ADR 0027) by a standalone `bun scripts/*-consumer.ts` job
in [check.yml](../../.github/workflows/check.yml), driving the channel exactly as a consumer receives it. The artifacts are assembled once on the Linux
`build` job from the just-built candidate bytes through the one target manifest (`scripts/targets.ts`); each job's pure logic is unit-tested under `bun
test` in `tests/release/` with no subprocess (the Bun 1.4.2 child-lifecycle defect, #149), and the real round-trip on real binaries is left to the CI job
— the way the compiled-binary smoke ([testing](./testing.md)) lives outside `bun test`.

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

## npm Launcher Consumer

The `npm-launcher-consumer` job ([check.yml](../../.github/workflows/check.yml)) verifies the thin, script-free npm launcher `@secantdev/secant`
(`bin/secant.mjs`, packed by `scripts/pack-launcher.ts`, #152) as a consumer receives it. Packing runs once on the Linux `build` job after the platform
packages: `scripts/pack-launcher.ts` pins the assembled release version, generates the host-key → package/executable map from the one target manifest
(`scripts/targets.ts`), and stages the Node launcher, that map, and the legal material — no candidate executable, exact-version `optionalDependencies` on
all three platform packages, and no lifecycle script — into one tarball beside them in the `platform-packages` artifact. On the Windows x64, macOS arm64,
and Linux x64 matrix, `scripts/launcher-consumer.ts` installs the launcher and the matching platform package with `npm install --ignore-scripts`
(`--omit=optional`, so the install is network-free; npm is the channel under test) and proves: argument/stdio/native-exit forwarding under an npm-flat
layout and under a pnpm-symlinked layout (the platform package is not hoisted, so resolution only works because the launcher canonicalizes its own path);
the before-spawn missing-optional-package diagnostic; and — the acceptance seam — the Proof Bundle smoke (the M3 gate) completed end to end THROUGH the
launched command: build + install the Test Repair Proof Bundle, launch it against the recorded Claude Code replayer to its authored Human Gate, and once
answered reach `succeeded` and make the authored commit. `tests/release/launcher.test.ts` unit-tests the pure logic — the launcher package.json shape
(`launcherPackageJson`), the host-key map (`launcherPlatforms`), and the launcher's own target selection and before-spawn diagnostics (`selectTarget`,
`resolveExecutable`, with an injected resolver) — and spawns no subprocess, for the same Bun 1.4.2 child-lifecycle reason (#149). Only the
install → launch → Proof Bundle round-trip on real binaries is left to this CI job. Real-platform unsupported-target detection is not exercised here
(a real spawn cannot spoof `process.platform`); the `selectTarget` unsupported branch is proven deterministically in `bun test` instead.

## Release Legal Closure

The M4 artifact-level legal gate (spec [#137](https://github.com/secantdev/secant/issues/137) stories 99/100,
[#156](https://github.com/secantdev/secant/issues/156)) extends the fast declared-dependency notices check — `checkNoticesCoverage` in
[tests/architecture/check-vendor-provenance.ts](../../tests/architecture/check-vendor-provenance.ts), which **stays** in `bun run check` — into a
target-specific release gate. Unlike the channel consumers it is OS-independent (text and digest comparison, no binary to run), so it needs no matrix:
it runs once, as the final step of the Linux `build` job (`scripts/inventory.ts`), the one place that has cross-compiled every target and installed every
platform's @opentui native, and it spawns no child process, so it cannot trip the Bun 1.4.2 child-lifecycle defect (#149/#150). It derives the transitive
runtime closure **actually embedded** per target from the actual compiler inputs (a real `Bun.build` of the shared build input, walked through the
sourcemap `sources`, each embedded file's version and licence read from the package that owns it on disk — the deepest `node_modules/` segment, so a
hoisted or nested duplicate reports the bytes actually shipped), adds the one `@opentui/core-<os>-<cpu>` native per target from the one target manifest
(`scripts/targets.ts`), names the embedded Bun runtime and vendored OpenCode subset as fixed members, and unions the three targets. It then verifies:
that `THIRD-PARTY-NOTICES.md` covers that union — every shipped component named, its shipped version named, and its licence family's text present,
failing closed on a missing component, a stale version, or an unrecognised licence identity — and that the source-of-truth legal material is what every
channel staged, by comparing each channel manifest's `licenseSha256`/`noticesSha256` (release archives, platform packages, launcher package) against the
repository files. The sibling consumer jobs already prove the physical bytes in each channel match those manifest digests (and the installer results the
archive's), so this need not re-extract them. Harmless historical or grouped extra notices are tolerated (a named entry no longer in the closure, e.g.
`bun-ffi-structs`, does not fail). Licence identity is verified at licence-family granularity — an unrecognised SPDX identity fails closed, but a
per-package prose mislabel within a known family is a named limitation, not caught. `tests/release/legal-closure.test.ts` unit-tests the pure logic
(`verifyClosureNotices`, `verifyChannelLegalDigests`, `packageDirOfSource`, `nativePackageFor`) and spawns no subprocess; only the closure derivation (a
real build) runs in the `build` job.

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

## Candidate Validation

The `candidate-validation` scenario (M4 spec [#137](https://github.com/secantdev/secant/issues/137) stories 85/89,
[#157](https://github.com/secantdev/secant/issues/157)) is the manual-dispatch mode of the one CI gate ([check.yml](../../.github/workflows/check.yml)),
not a second workflow: a `workflow_dispatch` run executes the whole gate on one commit — the three-OS canonical check, the cross-build/assemble, the
compiled-binary smoke, every consumer scenario above, the terminal lifecycle, the evidence contract, and the legal closure — against the single candidate
the `build` job assembles once. It adds the one thing a push/PR run cannot: a separately configured read-only npm identity (`secrets.NPM_READONLY_TOKEN`,
no publication authority) authenticates and publish-dry-runs every platform package first and the launcher last (`scripts/npm-dry-run.ts`), so the npm
release path is proven end to end with no route to publication. The dry-run is registry-facing and OS-independent, so it folds into the `build` job's
final step under `if: github.event_name == 'workflow_dispatch'`, gating the credential to that one manual run rather than paying for its own runner.

The deterministic release-workflow policy check (`tests/architecture/check-release-workflow.ts`, run under `bun test`) proves, over the parsed workflow,
that the candidate is assembled once and reused (job dependencies and download-not-rebuild), that the read-only identity is the only secret and is
dispatch-gated, and that no publication credential, real publish, GitHub-release step, retry, or public-asset path exists anywhere in it. Publication
itself — the tag-triggered, protected-`release`-environment job — is [#158](https://github.com/secantdev/secant/issues/158)/[#159](https://github.com/secantdev/secant/issues/159),
out of scope here. `tests/release/npm-dry-run.test.ts` unit-tests the pure dry-run ordering and spawns no subprocess; only the real `npm` round-trip runs
in the dispatched `build` job.
