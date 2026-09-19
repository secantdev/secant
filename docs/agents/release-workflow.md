# Release Workflow Policy

Read this before changing the release CI workflow's shape or its policy checks — the manual-dispatch candidate validation, the tag-triggered protected
promotion, or the deterministic checks that guard them. Consumer round-trips (archive, package, launcher, installer) are a separate concern in
[release-consumers.md](./release-consumers.md).

The whole release path is **one** CI gate ([check.yml](../../.github/workflows/check.yml)), not a family of workflows. A `push`/`pull_request` run is the
plain gate; a manual dispatch adds the authenticated npm dry-run; a `v*` tag adds the protected promotion. The candidate is assembled once on the Linux
`build` job and every downstream job downloads it. Two deterministic checks prove the shape over the parsed YAML (`Bun.YAML`, no dependency) in
[tests/architecture/check-release-workflow.ts](../../tests/architecture/check-release-workflow.ts): `checkValidationWorkflow` and `checkReleaseProtection`.
Each guard is proven by a synthetic
workflow that breaks exactly that guard, so a failure names the guard. Both run under `bun test`, so both are proven on Windows, macOS, and Linux without
publishing.

## Candidate Validation

The `candidate-validation` scenario (spec [#137](https://github.com/secantdev/secant/issues/137) stories 85/89,
[#157](https://github.com/secantdev/secant/issues/157)) is the manual-dispatch mode of the one gate: a `workflow_dispatch` run executes the whole gate on one
commit — the three-OS canonical check, the cross-build/assemble, the compiled-binary smoke, every release-channel consumer scenario
([release-consumers.md](./release-consumers.md)), the terminal lifecycle, the evidence contract, and the legal closure — against the single candidate the
`build` job assembles once. It adds the one thing a push/PR run cannot: a separately configured read-only npm identity (`secrets.NPM_READONLY_TOKEN`, no
publication authority) authenticates and publish-dry-runs every platform package first and the launcher last (`scripts/npm-dry-run.ts`), so the npm release
path is proven end to end with no route to publication. The dry-run is registry-facing and OS-independent, so it folds into the `build` job's final step under
`if: github.event_name == 'workflow_dispatch'`, gating the credential to that one manual run rather than paying for its own runner.

`checkValidationWorkflow` proves, over the parsed workflow, that the candidate is assembled once and reused (job dependencies and download-not-rebuild), that
the read-only identity is the only secret and is dispatch-gated, and — outside the one protected promotion job below — that no publication credential, real
publish, GitHub-release step, retry, or public-asset path exists anywhere in it. `tests/release/npm-dry-run.test.ts` unit-tests the pure dry-run ordering and
spawns no subprocess; only the real `npm` round-trip runs in the dispatched `build` job.

## Release Protection Policy

The `release-protection-policy` scenario (spec [#137](https://github.com/secantdev/secant/issues/137) stories 82/90/94/96/97,
[#158](https://github.com/secantdev/secant/issues/158)) adds the tag-admission and protected-`release`-environment boundary to the same one gate. A `v*` tag
reruns the whole gate on its commit through the existing `push:` trigger; then two tag-gated jobs promote it:

- `release-approval` depends on every candidate check, so it runs only once they are green. It runs `scripts/release-gate.ts`, which admits the tag **only
  when it exactly equals the package version** — no branch run substitutes — and writes the reviewer's approval summary: tag, commit, version, candidate
  digests (read from the downloaded candidate manifest, never rebuilt), blocking jobs, checklist reference (`docs/release-checklist.md`), and the Windows
  Terminal evidence trigger (fresh when the Bun pin, `@opentui/core` pin, or `src/tui/renderer/` changed since the previous tag, else carried forward). It
  holds no credential.
- `promote` depends on `release-approval` (and so, transitively, on every candidate check), targets the GitHub `release` environment, and holds no credential
  and no publish step. Its environment gate pauses the run until the sole required reviewer approves. Publication of the candidate bytes and its publication
  credential — scoped to that environment — are [#159](https://github.com/secantdev/secant/issues/159), out of scope here.

`checkReleaseProtection` verifies over the parsed workflow: the promote job targets `environment: release` and is the only job that may declare an
environment; its transitive `needs` closure includes every candidate check; both jobs are gated to a `v*` tag ref and the approval job runs the tag/version
gate; and no publication credential is reachable before the protected boundary. `tests/release/release-gate.test.ts` unit-tests the pure gate logic
(`tagMatchesVersion`, `windowsTerminalTrigger`, `formatApprovalSummary`) and spawns no subprocess; only the git/env/fs wiring runs in the `release-approval`
job.

## Human Configuration

Two facts live in GitHub settings, not in the repository, and must be configured and verified out of band before a real release (like #157's read-only token
setup, which is likewise documented rather than automated):

- The `release` environment has **Rohan as the sole required reviewer**, so a tag cannot promote without his explicit approval.
- Any publication credential is a GitHub **environment secret scoped only to the `release` environment**, never a repository- or organization-level secret —
  so the build, test, candidate, and pre-approval `release-approval` jobs cannot reach it.

The policy checks prove nothing publishes before the protected job; these two settings prove nothing can publish without the human gate.
