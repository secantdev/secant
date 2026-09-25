# Support Matrix

Every operating system, architecture, and terminal Secant claims to support, each with the evidence that backs the claim. A row without evidence is
not claimed. Mandated by [ADR 0027](./adr/0027-gate-releases-on-three-os-ci-and-recorded-human-evidence.md) ("`docs/support-matrix.md` lists every
claimed OS, architecture, and terminal row with its evidence source"); the [refactoring-gate](./agents/milestones.md) checklist requires it current. The three
gated build targets are fixed by [ADR 0030](./adr/0030-ship-the-shell-as-a-bun-compiled-single-file-executable.md), which also removed the
legacy-conhost row.

## Operating systems and architectures

Each cross-compiled single-file binary is built and then smoked on its own operating system inside the canonical three-OS gate, on every push and pull
request. The `build` job cross-compiles all three targets; the `consumer` job's `Compiled-binary smoke` step runs against the matching binary on the
matching runner. The scenarios it covers are enumerated once in [testing guidance](./agents/testing.md) — this row does not restate them.

| OS      | Architecture | Binary                   | Evidence                                                                                                                                                                                                         |
| ------- | ------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | x64          | `secant-windows-x64.exe` | M6 validation candidate, native `Compiled-binary smoke` on `windows-latest`, pass ([run 36093685185](https://github.com/secantdev/secant/actions/runs/36093685185/job/107941526021))                             |
| macOS   | arm64        | `secant-darwin-arm64`    | M6 validation candidate, native `Compiled-binary smoke` on `macos-latest`, pass including `codesign --verify` ([run 36093685185](https://github.com/secantdev/secant/actions/runs/36093685185/job/107941525993)) |
| Linux   | x64          | `secant-linux-x64`       | M6 validation candidate, native `Compiled-binary smoke` on `ubuntu-latest`, pass ([run 36093685185](https://github.com/secantdev/secant/actions/runs/36093685185/job/107941526083))                              |

## Terminals

CI cannot drive a real terminal, so terminal support rests on a human-recorded real-terminal check per release (ADR 0027). The re-run path is
`bun run check:windows-terminal` (`scripts/release-checks/windows-terminal.ts`). The M6 validation recorded a fresh pass against the exact Windows
candidate binary (`c1fab9956073b39ab689793f0a4232260986c521b98106fb28a9bd296ffa9577`).

| Terminal                      | Host                               | Evidence                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Terminal 1.24.11911.0 | Windows 11 (10.0.26200), Bun 1.4.2 | M6 human real-terminal check, pass — quit binding and Ctrl+C both delivered, shell exited, terminal stayed responsive ([#229 report](https://github.com/secantdev/secant/issues/229#issuecomment-5826887886)) |

Legacy conhost is deliberately **not** a claimed row: ADR 0030 removed it. The M6 report observed that the notice appeared and stayed readable until a
keypress, while the window did not survive quit; those observations do not decide the Windows Terminal outcome.

## Harnesses

Harness support is claimed only from a digest-bound report produced against an
installed, authenticated real Harness. The deterministic Claude Code and Codex
recordings prove Adapter behavior against recorded bytes; they do **not** prove
compatibility with a currently installed Harness and do not support a
real-Harness or three-OS parity claim.

The M6 validation recorded both Harness passes on Windows x64 against candidate
binary SHA-256 `c1fab9956073b39ab689793f0a4232260986c521b98106fb28a9bd296ffa9577`.
These rows make no macOS, Linux, or cross-operating-system real-Harness claim.

Three-OS replay evidence comes from the `check` job's `Process runtime conformance` step (standalone runtime conformance,
[ADR 0027 amendment 2026-09-21](./adr/0027-gate-releases-on-three-os-ci-and-recorded-human-evidence.md);
`tests/process/runtime-conformance.ts`), which drives the real Adapters against recorded-protocol replayers; it is replay evidence, not
installed-Harness evidence.

| Harness     | OS/architecture | Installed version | Evidence                                                                                                                              |
| ----------- | --------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Windows x64     | 2.1.229           | M6 installed-Harness Proof Bundle check, pass ([#229 report](https://github.com/secantdev/secant/issues/229#issuecomment-5826658840)) |
| Codex       | Windows x64     | 0.155.0           | M6 installed-Harness Proof Bundle check, pass ([#229 report](https://github.com/secantdev/secant/issues/229#issuecomment-5826665548)) |
