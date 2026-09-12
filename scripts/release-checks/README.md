# Human release checks

## Windows Terminal

Run this check on Windows when the Bun pin, OpenTUI pin, or
`src/tui/renderer/` has changed. It must use the final packed build for the
release; the pseudo-terminal CI job does not replace this real-terminal check.

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
   release checklist issue (milestone #48 for M1). The conhost row records what
   happened but does not decide the outcome.

Pass an explicit binary path when checking a downloaded artefact:

```powershell
bun run check:windows-terminal -- C:\path\to\secant-windows-x64.exe
```
