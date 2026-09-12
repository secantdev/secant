export interface WindowsTerminalReport {
  readonly osVersion: string;
  readonly terminalVersion: string;
  readonly runtimeVersion: string;
  readonly packageVersion: string;
  readonly artefactDigest: string;
  readonly timestamp: string;
  readonly quitBindingPassed: boolean;
  readonly ctrlCPassed: boolean;
  readonly conhostNoticeAppeared: boolean;
  readonly conhostWindowSurvived: boolean;
}

function formatPassFail(value: boolean): "pass" | "fail" {
  return value ? "pass" : "fail";
}

function formatYesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

export function formatWindowsTerminalReport(
  report: WindowsTerminalReport,
): string {
  const outcome =
    report.quitBindingPassed && report.ctrlCPassed ? "pass" : "fail";
  return `## Windows Terminal human real-terminal check

- Check name: Windows Terminal human real-terminal check
- OS and version: ${report.osVersion}
- Terminal: ${report.terminalVersion}
- Runtime version: ${report.runtimeVersion}
- Package version and digest: ${report.packageVersion}; SHA-256 ${report.artefactDigest}
- Outcome: ${outcome}
- Timestamp: ${report.timestamp}

| Host | Exit path | Observation | Result |
| --- | --- | --- | --- |
| Windows Terminal | quit binding (q) | Key delivered, shell exited, and terminal remained responsive | ${formatPassFail(report.quitBindingPassed)} |
| Windows Terminal | Ctrl+C | Key delivered, shell exited, and terminal remained responsive | ${formatPassFail(report.ctrlCPassed)} |
| legacy conhost (observed only; does not decide outcome) | quit binding (q) | Startup notice appeared | ${formatYesNo(report.conhostNoticeAppeared)} |
| legacy conhost (observed only; does not decide outcome) | quit binding (q) | Window survived and remained responsive | ${formatYesNo(report.conhostWindowSurvived)} |`;
}
