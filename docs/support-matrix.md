# Support Matrix

Every operating system, architecture, and terminal Secant claims to support, each with the evidence that backs the claim. A row without evidence is
not claimed. Mandated by [ADR 0027](./adr/0027-gate-releases-on-three-os-ci-and-recorded-human-evidence.md) ("`docs/support-matrix.md` lists every
claimed OS, architecture, and terminal row with its evidence source"); the [G1 gate](./agents/milestones.md) checklist requires it current. The three
gated build targets are fixed by [ADR 0030](./adr/0030-ship-the-shell-as-a-bun-compiled-single-file-executable.md), which also removed the
legacy-conhost row.

## Operating systems and architectures

Each cross-compiled single-file binary is built and then smoked on its own operating system inside the canonical three-OS gate, on every push and pull
request. The `build` job cross-compiles all three targets; the `smoke` job runs the compiled-binary smoke against the matching binary on the matching
runner. The scenarios it covers are enumerated once in [testing guidance](./agents/testing.md) — this row does not restate them.

| OS      | Architecture | Binary                   | Evidence                                                                                                                                                                                             |
| ------- | ------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | x64          | `secant-windows-x64.exe` | M4 candidate validation, native `smoke` job on `windows-latest`, pass ([run 35456179025](https://github.com/secantdev/secant/actions/runs/35456179025/job/105931868946))                             |
| macOS   | arm64        | `secant-darwin-arm64`    | M4 candidate validation, native `smoke` job on `macos-latest`, pass including `codesign --verify` ([run 35456179025](https://github.com/secantdev/secant/actions/runs/35456179025/job/105931868927)) |
| Linux   | x64          | `secant-linux-x64`       | M4 candidate validation, native `smoke` job on `ubuntu-latest`, pass ([run 35456179025](https://github.com/secantdev/secant/actions/runs/35456179025/job/105931868913))                              |

## Terminals

CI cannot drive a real terminal, so terminal support rests on a human-recorded real-terminal check per release (ADR 0027). The re-run path is
`bun run check:windows-terminal` (`scripts/release-checks/windows-terminal.ts`). The M4 validation recorded a fresh pass against the exact Windows
candidate binary (`593ee7ae861807c8e0fc79f9fe17e9000246411e8aa0a5ee9df07632e138bc51`).

| Terminal                      | Host                               | Evidence                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Terminal 1.24.11911.0 | Windows 11 (10.0.26200), Bun 1.4.2 | M4 human real-terminal check, pass — quit binding and Ctrl+C both delivered, shell exited, terminal stayed responsive ([#160 report](https://github.com/secantdev/secant/issues/160#issuecomment-5743869546)) |

Legacy conhost is deliberately **not** a claimed row: ADR 0030 removed it, and the M4 check observed conhost only (it "does not decide outcome").

## Harnesses

Harness support is claimed only from a digest-bound report produced against an
installed, authenticated real Harness. The deterministic Claude Code and Codex
recordings prove Adapter behavior against recorded bytes; they do **not** prove
compatibility with a currently installed Harness and do not support a
real-Harness or three-OS parity claim.

The M4 validation recorded both Harness passes on Windows x64 against candidate
binary SHA-256 `593ee7ae861807c8e0fc79f9fe17e9000246411e8aa0a5ee9df07632e138bc51`.
These rows make no macOS, Linux, or cross-operating-system real-Harness claim.

| Harness     | OS/architecture | Installed version | Evidence                                                                                                                              |
| ----------- | --------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Windows x64     | 2.1.229           | M4 installed-Harness Proof Bundle check, pass ([#160 report](https://github.com/secantdev/secant/issues/160#issuecomment-5744389697)) |
| Codex       | Windows x64     | 0.155.0           | M4 installed-Harness Proof Bundle check, pass ([#160 report](https://github.com/secantdev/secant/issues/160#issuecomment-5744297855)) |
