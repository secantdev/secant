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

function passFail(value: boolean): "pass" | "fail" {
  return value ? "pass" : "fail";
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
): string {
  return `### External Proof Bundle observations

| Observation | Result |
| --- | --- |
| Test repair | ${passFail(evidence.repairPassed)} |
| Authored approve-commit gate | ${passFail(evidence.authoredGateReached)} |
| Commit absent before approval | ${passFail(!evidence.committedBeforeApproval)} |
| Run succeeded after approval | ${passFail(evidence.runSucceededAfterApproval)} |
| Post-approval commit | ${passFail(evidence.postApprovalCommitObserved)} |`;
}
