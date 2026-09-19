import {
  formatReleaseEvidenceReport,
  type ReleaseEvidenceReport,
} from "./release-evidence.js";

export type WindowsTerminalEvidence =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "carry-forward";
      readonly report: string;
      readonly comparison: string;
    };

export interface WindowsTerminalReport {
  readonly report: ReleaseEvidenceReport;
  readonly evidence: WindowsTerminalEvidence;
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
  const observedOutcome =
    report.quitBindingPassed && report.ctrlCPassed ? "pass" : "fail";
  if (report.report.subject.kind !== "terminal") {
    throw new Error("Windows Terminal evidence requires a terminal subject.");
  }
  if (report.report.outcome !== observedOutcome) {
    throw new Error(
      "Windows Terminal observations must agree with the common report outcome.",
    );
  }
  if (
    report.evidence.kind === "carry-forward" &&
    (report.evidence.report.trim().length === 0 ||
      report.evidence.comparison.trim().length === 0)
  ) {
    throw new Error(
      "Carry-forward evidence requires a named prior report and comparison.",
    );
  }
  const evidence =
    report.evidence.kind === "fresh"
      ? "- Evidence basis: fresh real-terminal check"
      : `- Evidence basis: carry-forward from ${report.evidence.report}
- Named comparison: ${report.evidence.comparison}`;
  return `${formatReleaseEvidenceReport(report.report)}
${evidence}

| Host | Exit path | Observation | Result |
| --- | --- | --- | --- |
| Windows Terminal | quit binding (q) | Key delivered, shell exited, and terminal remained responsive | ${formatPassFail(report.quitBindingPassed)} |
| Windows Terminal | Ctrl+C | Key delivered, shell exited, and terminal remained responsive | ${formatPassFail(report.ctrlCPassed)} |
| legacy conhost (observed only; does not decide outcome) | quit binding (q) | Startup notice appeared | ${formatYesNo(report.conhostNoticeAppeared)} |
| legacy conhost (observed only; does not decide outcome) | quit binding (q) | Window survived and remained responsive | ${formatYesNo(report.conhostWindowSurvived)} |`;
}
