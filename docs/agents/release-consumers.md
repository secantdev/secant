# Release-Channel Consumer Verification

Read this before changing a release-channel consumer scenario — the archive, platform-package, npm-launcher, or installer steps — or the scripts and CI
they run through.

Each shipped release channel is verified on the Windows x64, macOS arm64, and Linux x64 matrix (ADR 0027) by a named step of the per-OS `consumer` job in
[check.yml](../../.github/workflows/check.yml), driving the channel exactly as a consumer receives it. That job downloads each candidate artifact once,
runs the compiled-binary smoke, archive, platform-package, npm-launcher, PowerShell installer, POSIX installer, and terminal-lifecycle scenarios as seven
independent `continue-on-error` steps, then always aggregates their outcomes so every result stays visible and any non-success fails the job. The artifacts
are assembled once on the Linux `build` job from the just-built candidate bytes through the one target manifest (`scripts/targets.ts`). Release-channel
pure logic is unit-tested under `bun test` in `tests/release/` with no subprocess (the Bun 1.4.2 child-lifecycle defect, #149); real round-trips on real
binaries remain in the consumer job, the way the compiled-binary smoke ([testing](./testing.md)) lives outside `bun test`. The per-OS `check` job's
`Process runtime conformance` step is the sibling layer for real child processes below the binary; it is not a consumer scenario ([testing](./testing.md)).

## Release Archive Consumer

Separate from the package smoke, the `Release archive consumer` step ([check.yml](../../.github/workflows/check.yml)) verifies the assembled release
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

The `Platform package consumer` step ([check.yml](../../.github/workflows/check.yml)) verifies the three per-platform npm packages (`scripts/pack.ts`,
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

The `npm launcher consumer` step ([check.yml](../../.github/workflows/check.yml)) verifies the thin, script-free npm launcher `@secantdev/secant`
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
repository files. The sibling consumer steps already prove the physical bytes in each channel match those manifest digests (and the installer results the
archive's), so this need not re-extract them. Harmless historical or grouped extra notices are tolerated (a named entry no longer in the closure, e.g.
`bun-ffi-structs`, does not fail). Licence identity is verified at licence-family granularity — an unrecognised SPDX identity fails closed, but a
per-package prose mislabel within a known family is a named limitation, not caught. `tests/release/legal-closure.test.ts` unit-tests the pure logic
(`verifyClosureNotices`, `verifyChannelLegalDigests`, `packageDirOfSource`, `nativePackageFor`) and spawns no subprocess; only the closure derivation (a
real build) runs in the `build` job.

## PowerShell Installer Consumer

The `PowerShell installer consumer` step ([check.yml](../../.github/workflows/check.yml)) supplies the assembled
candidate through a network-free local-candidate seam. The macOS arm64 and Linux x64 legs exercise native unsupported-target
detection before candidate access. The Windows x64 leg installs into an isolated home, runs the installed executable,
exercises latest and exact versions, executes the declined PATH instruction twice, and checks idempotent default PATH changes.
It preserves the installed bytes across missing input, malformed manifest/version, target-identity, checksum, layout,
inner-binary, legal-material, and executable-version failures. The scenario invokes native PowerShell and the standalone
candidate only; it requires no Git Bash, Node, Bun, credentials, or network. A directory-swap failure is deliberately not
induced: doing so deterministically would require a private installer hook or an inherently racy Windows file lock.

## POSIX Installer Consumer

The `POSIX installer consumer` step ([check.yml](../../.github/workflows/check.yml)) runs `scripts/posix-installer-consumer.sh` (the POSIX sibling of
`scripts/powershell-installer-consumer.ps1`) to give root `install.sh` the local candidate without a product runtime. On macOS arm64 and Linux x64 the
`supported` scenario installs the real candidate under fixed `~/.secant/bin` in an isolated home and proves: the executable runs and reports the candidate
version, `LICENSE`/`THIRD-PARTY-NOTICES.md` are installed while `SECANT_HOME` is not used as the install root, the declined-PATH instruction is printed
(with macOS Terminal guidance), exact-version selection accepts the matching version and rejects a mismatch, and PATH modification is idempotent. It then
tampers a local copy to prove a malformed candidate — a checksum, archive-layout, manifest-version, or legal-material fault — is refused while the existing
installation is preserved, each assertion naming its scenario on failure. Windows x64 runs the `unsupported` scenario, proving only refusal before candidate
access. This restores at the compiled-binary layer the coverage the deterministic `tests/release/posix-installer.test.ts` suite carried before it was retired
in the #185 subprocess-test migration so the semantic suite spawns no child; the install, replacement, and tamper round-trips on the real binary live only
in this CI job, the way the compiled-binary smoke ([testing](./testing.md)) lives outside `bun test`.

The manual-dispatch candidate validation and the tag-triggered protected promotion are workflow-shape policy, not consumer round-trips; they live in
[release-workflow.md](./release-workflow.md).
