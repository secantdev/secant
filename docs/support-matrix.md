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

| OS      | Architecture | Binary                   | Evidence                                                                                                                 |
| ------- | ------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Windows | x64          | `secant-windows-x64.exe` | Canonical CI gate, `smoke` job on `windows-latest` ([check.yml](../.github/workflows/check.yml))                         |
| macOS   | arm64        | `secant-darwin-arm64`    | Canonical CI gate, `smoke` job on `macos-latest`, plus `codesign --verify` ([check.yml](../.github/workflows/check.yml)) |
| Linux   | x64          | `secant-linux-x64`       | Canonical CI gate, `smoke` job on `ubuntu-latest` ([check.yml](../.github/workflows/check.yml))                          |

## Terminals

CI cannot drive a real terminal, so terminal support rests on a human-recorded real-terminal check per release (ADR 0027). The re-run path is
`bun run check:windows-terminal` (`scripts/release-checks/windows-terminal.ts`). The check has been **re-armed** since the M1 evidence below: a
`src/tui/renderer/` change lands after that pass, which by the release-check rule requires the Windows Terminal check to be re-run. The row still cites
only the M1 pass — no new pass is claimed here until a fresh report is recorded.

| Terminal              | Host                               | Evidence                                                                                                                                                                                                    |
| --------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Terminal 1.24 | Windows 11 (10.0.26200), Bun 1.4.2 | M1 human real-terminal check, pass — quit binding and Ctrl+C both delivered, shell exited, terminal stayed responsive ([#48 report](https://github.com/secantdev/secant/issues/48#issuecomment-5645636636)) |

Legacy conhost is deliberately **not** a claimed row: ADR 0030 removed it, and the M1 check observed conhost only (it "does not decide outcome").
