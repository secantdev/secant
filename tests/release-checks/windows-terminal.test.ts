import assert from "node:assert/strict";
import test from "node:test";
import { formatWindowsTerminalReport } from "../../scripts/release-checks/windows-terminal-report.js";

test("formats the ADR 0027 report with a non-deciding conhost observation", () => {
  const report = formatWindowsTerminalReport({
    report: {
      checkName: "Windows Terminal human real-terminal check",
      operatingSystem: { name: "Windows 11", version: "10.0.26100" },
      subject: {
        kind: "terminal",
        name: "Windows Terminal",
        version: "1.23.1234.0",
      },
      bunVersion: "1.4.2",
      secantVersion: "0.1.0",
      binarySha256: "a".repeat(64),
      outcome: "pass",
      timestamp: "2026-09-12T12:34:56.000Z",
    },
    evidence: { kind: "fresh" },
    quitBindingPassed: true,
    ctrlCPassed: true,
    conhostNoticeAppeared: true,
    conhostWindowSurvived: false,
  });

  assert.equal(
    report,
    `## Windows Terminal human real-terminal check

- Check name: Windows Terminal human real-terminal check
- OS and version: Windows 11 10.0.26100
- Terminal: Windows Terminal 1.23.1234.0
- Bun version: 1.4.2
- Secant version: 0.1.0
- Binary SHA-256: ${"a".repeat(64)}
- Outcome: pass
- UTC timestamp: 2026-09-12T12:34:56.000Z
- Evidence basis: fresh real-terminal check

| Host | Exit path | Observation | Result |
| --- | --- | --- | --- |
| Windows Terminal | quit binding (q) | Key delivered, shell exited, and terminal remained responsive | pass |
| Windows Terminal | Ctrl+C | Key delivered, shell exited, and terminal remained responsive | pass |
| legacy conhost (observed only; does not decide outcome) | quit binding (q) | Startup notice appeared | yes |
| legacy conhost (observed only; does not decide outcome) | quit binding (q) | Window survived and remained responsive | no |`,
  );
});
