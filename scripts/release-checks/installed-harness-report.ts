export interface ProofBundleObservations {
  readonly repairPassed: boolean;
  readonly authoredGateReached: boolean;
  readonly committedBeforeApproval: boolean;
  readonly runSucceededAfterApproval: boolean;
  readonly postApprovalCommitObserved: boolean;
}

export interface ProofBundleEvidence extends ProofBundleObservations {
  readonly outcome: "pass" | "fail";
}

export interface ObservedHarnessIdentity {
  readonly name: string;
  readonly version: string;
}

export interface InstalledHarnessProblem {
  readonly code: string;
  readonly explanation: string;
  readonly remediation: string;
}

export interface CommandDiagnostics {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface InstalledHarnessFailureDiagnostics {
  readonly launch: CommandDiagnostics;
  readonly postApprovalRun?: CommandDiagnostics;
  readonly commitVerdict?: CommandDiagnostics;
  readonly commitOutput?: CommandDiagnostics;
  readonly problem?: InstalledHarnessProblem;
  readonly transcript?: string;
}

interface ObjectValue {
  readonly [key: string]: unknown;
}

function passFail(value: boolean): "pass" | "fail" {
  return value ? "pass" : "fail";
}

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
}

function commandStatus(value: CommandDiagnostics | undefined): string {
  return value === undefined ? "not run" : String(value.status);
}

function commandStream(
  value: CommandDiagnostics | undefined,
  stream: "stdout" | "stderr",
): string {
  return tableCell(
    value?.[stream] || (value === undefined ? "not run" : "(empty)"),
  );
}

function object(value: unknown): ObjectValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as ObjectValue;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function nested(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const part of path) current = object(current)?.[part];
  return current;
}

export function parseInstalledHarnessProblem(
  value: unknown,
): InstalledHarnessProblem | undefined {
  const candidate = object(value);
  const code = nonEmptyString(candidate?.code);
  const explanation = nonEmptyString(candidate?.explanation);
  const remediation = nonEmptyString(candidate?.remediation);
  if (
    code === undefined ||
    explanation === undefined ||
    remediation === undefined
  ) {
    return undefined;
  }
  return { code, explanation, remediation };
}

export function parseTerminalHarnessDiagnostic(
  value: unknown,
): string | undefined {
  const complete = nested(value, "export", "entries");
  const page = nested(value, "page", "entries");
  const entries = Array.isArray(complete)
    ? complete
    : Array.isArray(page)
      ? page
      : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = object(entries[index]);
    if (entry?.role !== "assistant") continue;
    const content = nonEmptyString(entry.content);
    if (content !== undefined) return content;
  }
  return undefined;
}

/** Validate the installed identity observed by the candidate Run. */
export function parseObservedHarnessIdentity(
  value: unknown,
): ObservedHarnessIdentity {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("name" in value) ||
    !("executableVersion" in value)
  ) {
    throw new Error("The Run did not report an observed installed Harness.");
  }
  if (
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    typeof value.executableVersion !== "string" ||
    value.executableVersion.trim().length === 0
  ) {
    throw new Error(
      "The Run did not report its observed installed-Harness name and version.",
    );
  }
  return { name: value.name, version: value.executableVersion };
}

export function observedHarnessForReport(
  selectedName: string,
  value: unknown,
  outcome: "pass" | "fail",
): ObservedHarnessIdentity {
  if (value === undefined && outcome === "fail") {
    return { name: selectedName, version: "not observed" };
  }
  return parseObservedHarnessIdentity(value);
}

export function evaluateProofBundleEvidence(
  observations: ProofBundleObservations,
): ProofBundleEvidence {
  const outcome =
    observations.repairPassed &&
    observations.authoredGateReached &&
    !observations.committedBeforeApproval &&
    observations.runSucceededAfterApproval &&
    observations.postApprovalCommitObserved
      ? "pass"
      : "fail";
  return { ...observations, outcome };
}

export function formatInstalledHarnessDetails(
  evidence: ProofBundleEvidence,
  diagnostics?: InstalledHarnessFailureDiagnostics,
): string {
  const observations = `### External Proof Bundle observations

| Observation | Result |
| --- | --- |
| Test repair | ${passFail(evidence.repairPassed)} |
| Authored approve-commit gate | ${passFail(evidence.authoredGateReached)} |
| Commit absent before approval | ${passFail(!evidence.committedBeforeApproval)} |
| Run succeeded after approval | ${passFail(evidence.runSucceededAfterApproval)} |
| Post-approval commit | ${passFail(evidence.postApprovalCommitObserved)} |`;
  if (evidence.outcome === "pass" || diagnostics === undefined) {
    return observations;
  }
  return `${observations}

### Failed installed-Harness diagnostics

| Diagnostic | Observation |
| --- | --- |
| Launch exit status | ${commandStatus(diagnostics.launch)} |
| Problem code | ${tableCell(diagnostics.problem?.code ?? "not reported")} |
| Problem explanation | ${tableCell(diagnostics.problem?.explanation ?? "not reported")} |
| Problem remediation | ${tableCell(diagnostics.problem?.remediation ?? "not reported")} |
| Launch stdout | ${commandStream(diagnostics.launch, "stdout")} |
| Launch stderr | ${commandStream(diagnostics.launch, "stderr")} |
| Post-approval run exit status | ${commandStatus(diagnostics.postApprovalRun)} |
| Post-approval run stdout | ${commandStream(diagnostics.postApprovalRun, "stdout")} |
| Post-approval run stderr | ${commandStream(diagnostics.postApprovalRun, "stderr")} |
| Commit verdict read exit status | ${commandStatus(diagnostics.commitVerdict)} |
| Captured commit verdict | ${commandStream(diagnostics.commitVerdict, "stdout")} |
| Commit output read exit status | ${commandStatus(diagnostics.commitOutput)} |
| Captured commit stdout/stderr | ${commandStream(diagnostics.commitOutput, "stdout")} |
| Retained terminal Turn or Harness diagnostic | ${tableCell(diagnostics.transcript ?? "not reported")} |`;
}
