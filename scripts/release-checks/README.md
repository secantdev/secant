# Human release checks

Every report uses the contract in `release-evidence.ts`: check name,
OS/version, terminal-or-Harness name/version, Bun version, Secant version, the
exact candidate binary's SHA-256, outcome, and UTC timestamp. Reports apply only
to those candidate bytes.

## Windows Terminal

Run this check on Windows when the Bun pin, OpenTUI pin, or
`src/tui/renderer/` has changed. It must use the final compiled single-file
executable for the release (ADR 0030); the pseudo-terminal CI job does not
replace this real-terminal check.

1. Open a Windows Terminal tab at the repository root.
2. Install the exact locked dependencies with `bun install --frozen-lockfile`.
3. Run `bun run check`. This runs the canonical gate and leaves the host build
   at `dist/secant-windows-x64.exe`.
4. Run `bun run check:windows-terminal` and follow every prompt. The script
   verifies the binary version, computes its SHA-256 digest, prepares an
   approved temporary Workspace, and guides the Windows Terminal and
   observed-only legacy-conhost runs.
5. Only a report whose Windows Terminal outcome is `pass` satisfies the release
   check. Paste the complete Markdown report printed by the script into the
   release checklist issue for the milestone currently in progress (the open
   milestone gate issue), not a pinned issue number. The conhost row records what
   happened but does not decide the outcome.

The generated report records `fresh real-terminal check`. When the Bun pin,
OpenTUI pin, and renderer are unchanged, the release checklist may instead name
the prior passing report and the exact comparison that proves none of those
triggers changed. Record both names as the report's `carry-forward` evidence
basis; an unnamed or informal comparison cannot carry evidence forward.

Pass an explicit binary path when checking a downloaded artefact:

```powershell
bun run check:windows-terminal -- C:\path\to\secant-windows-x64.exe
```

## Installed Claude Code and Codex

These are headless checks: the script drives `secant run launch --json` with
`--harness-requests allow`, and no Secant TUI or separate window opens. They
never run in CI.

Before running either check, prepare:

- the final external candidate and the external Test Repair Proof Bundle;
- the selected real Harness, installed and authenticated; and
- a disposable Git worktree containing the failing baseline expected by the
  Proof Bundle.

PowerShell 7 is not a prerequisite. On Windows the maintained Proof Bundle uses
the built-in `powershell.exe`. The check intentionally approves the authored
gate and leaves the resulting repair commit in the disposable worktree.

Run each check against the final external candidate and the same external Proof
Bundle bytes:

```sh
bun run check:claude-code -- /path/to/secant /path/to/test-repair.wfb /path/to/workspace relative/path/to/failing-test
bun run check:codex -- /path/to/secant /path/to/test-repair.wfb /path/to/workspace relative/path/to/failing-test
```

Each check uses a fresh isolated `SECANT_HOME`, supplies only the selected
Harness id, and decides its outcome from observable Test Repair behavior: the
repair Verdict passes, the authored `approve-commit` gate is reached before any
commit, and approval succeeds with a passing post-approval commit Verdict. The
report records the Harness name and installed version observed through the Run,
not a replay fixture version.

The deterministic `release-evidence-contract` scenario tests the shared schema,
formatters, every Proof Bundle outcome predicate, and the Windows/macOS/Linux
report shapes. It deliberately does not fake the candidate CLI's command parser,
Git, or process spawning: those are exercised by this opt-in check against the
external candidate, while the canonical package smoke already owns the same
launch/gate/commit sequence against recorded Harnesses.
