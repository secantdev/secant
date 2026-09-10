# Gate Releases On Three-OS CI And Recorded Human Evidence

Every push and pull request runs the canonical `npm run check` on Windows x64, macOS arm64, and Linux x64 with one pinned Node version, and a red job
on any operating system blocks merge. A release is a `v*` tag whose workflow re-runs that gate on all three, then publishes to npm from CI behind a
`release` GitHub environment with one required human reviewer. Nothing is published from a developer machine. The
[cross-platform gate decision](https://github.com/DevFlow-HQ/devflow-cli/issues/26) fixes this because the repository is public, so the runners
are free, Windows is the first-priority platform, and the OpenTUI prototype showed that Windows defects appear only on Windows.

## What CI proves

- The deterministic suite runs the Proof Bundle end to end through the headless client against fake Harness programs that replay the recorded
  protocol fixtures over stdio, so real process spawning, Windows `.cmd` shim resolution, `node:sqlite`, and per-Run Git are exercised on each OS
  without credentials. The replayer proves nothing about compatibility with a real Harness; only the recordings' provenance and the per-release
  real-Harness run make that claim.
- The package smoke installs the packed archive under a temporary global prefix and runs one headless Proof Bundle Run from the installed command,
  because missing `files` entries, ESM resolution, and OpenTUI's per-platform native binary only fail from the installed package.
- A small real-terminal lifecycle suite runs under a throwaway pseudo-terminal as its own blocking CI job on all three operating systems, outside
  `npm run check`. `node-pty` is a devDependency for that suite only; the import-boundary check keeps it out of `src/`. The
  [runtime decision](https://github.com/DevFlow-HQ/devflow-cli/issues/21) retired PTY as a Harness transport, not as test instrumentation.
- No CI retries. A flaky test is fixed or moved to the opt-in suite, and the implementing issue records which.

## What only a human proves

A pseudo-terminal is not a terminal, and ConPTY gave wrong answers twice before a real `conhost.exe` window showed the console-death defect
([#33](https://github.com/DevFlow-HQ/devflow-cli/issues/33)). Human-run checks therefore live in `scripts/release-checks/`, share one report shape
(check name, OS and version, terminal or Harness version, Node version, package version and digest, outcome, timestamp), and are pasted into a
per-release checklist issue. The reviewer approves the `release` environment only once the checklist is complete; the digest stops an old report
from covering a new build.

- On Windows the CI terminal suite runs under ConPTY and proves only that terminal modes are restored; it cannot observe the console-death class.
  Both Windows support-matrix rows (Windows Terminal and legacy conhost) therefore rest on the human real-terminal check, required only when
  the OpenTUI pin, `engines.node`, or `src/tui/renderer/` changed since the previous tag; the release workflow states which in its approval
  summary and otherwise cites the carried-forward report. macOS and Linux terminal rows rest on the CI suite plus a spot check per major TUI
  change ([amended 2026-09-07](https://github.com/DevFlow-HQ/devflow-cli/issues/22)).
- One real installed-Harness run per Harness on one operating system per release. Real Harnesses never run in CI.
- `docs/support-matrix.md` lists every claimed OS, architecture, and terminal row with its evidence source. A row without evidence is not claimed.

## Rejected options

- **Linux-only PR gate with Windows and macOS at release time.** Cheaper per run, and it discovers Windows path bugs at the most expensive moment.
- **Publishing from a laptop.** Lets the three-OS gate and the checklist be skipped by accident.
- **In-process fake Adapter as the only end-to-end double.** Never exercises spawning or shim resolution, and cannot be reached from the installed package.
- **Recording real-terminal evidence nowhere.** A gate nobody can automate still needs a record of what was checked against which build.

## Amendment — Bun-compiled release artefacts (2026-09-10, ADR 0030)

[ADR 0030](./0030-ship-the-shell-as-a-bun-compiled-single-file-executable.md), taken after the
[#60](https://github.com/secantdev/secant/issues/60#issuecomment-5623212589) Windows soak passed, changes this ADR:

- **One pinned Node version** → one **exactly pinned Bun**; the gate runs the canonical check under it on the three-OS matrix.
- **Publishes to npm from CI** → CI publishes **per-platform single-file binaries** (Windows x64, macOS arm64, Linux x64) plus the
  `@secantdev/secant` npm launcher; the packed-tarball package smoke becomes the compiled-binary smoke.
- The human real-terminal check retargets from legacy conhost to **Windows Terminal**, and its trigger changes from `engines.node` to the **Bun
  pin** (alongside the OpenTUI pin and `src/tui/renderer/`); a Bun bump re-arms it. The legacy-conhost support-matrix row is **removed**, reduced to
  a startup notice.
- The real-terminal lifecycle suite runs under **`Bun.Terminal`**; the `node-pty` devDependency is removed.

The three-OS gate, what CI proves, what only a human proves, the shared report shape, and `docs/support-matrix.md` are otherwise unchanged. Where
this ADR and ADR 0030 differ, ADR 0030 governs.
