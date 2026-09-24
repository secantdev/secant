import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatReleaseEvidenceReport,
  parseReleaseEvidenceReport,
  type ReleaseEvidenceReport,
} from "../../scripts/release-checks/release-evidence.js";
import {
  evaluateProofBundleEvidence,
  formatInstalledHarnessDetails,
  observedHarnessForReport,
  parseInstalledHarnessProblem,
  parseObservedHarnessIdentity,
  parseTerminalHarnessDiagnostic,
} from "../../scripts/release-checks/installed-harness-report.js";
import { formatWindowsTerminalReport } from "../../scripts/release-checks/windows-terminal-report.js";

const digest = "a".repeat(64);

function report(
  subject: ReleaseEvidenceReport["subject"],
): ReleaseEvidenceReport {
  return {
    checkName: `${subject.name} release check`,
    operatingSystem: { name: "TestOS", version: "1.2.3" },
    subject,
    bunVersion: "1.4.2",
    secantVersion: "0.1.0",
    binarySha256: digest,
    outcome: "pass",
    timestamp: "2026-09-19T12:34:56.000Z",
  };
}

test("[release-evidence-contract] terminal and both Harness reports share one digest-bound shape", () => {
  const reports = [
    {
      ...report({
        kind: "terminal",
        name: "Windows Terminal",
        version: "1.24.10393.0",
      }),
      operatingSystem: { name: "Windows", version: "11" },
    },
    {
      ...report({ kind: "harness", name: "Claude Code", version: "2.1.273" }),
      operatingSystem: { name: "macOS", version: "15.6" },
    },
    {
      ...report({ kind: "harness", name: "Codex", version: "0.42.0" }),
      operatingSystem: { name: "Linux", version: "6.8" },
    },
  ];

  for (const candidate of reports) {
    assert.deepEqual(parseReleaseEvidenceReport(candidate), candidate);
    const markdown = formatReleaseEvidenceReport(candidate);
    assert.match(markdown, new RegExp(`Check name: ${candidate.checkName}`));
    assert.match(
      markdown,
      new RegExp(
        `OS and version: ${candidate.operatingSystem.name} ${candidate.operatingSystem.version.replace(".", "\\.")}`,
      ),
    );
    assert.match(
      markdown,
      new RegExp(
        `${candidate.subject.kind === "terminal" ? "Terminal" : "Harness"}: ${candidate.subject.name} ${candidate.subject.version}`,
      ),
    );
    assert.match(markdown, /Bun version: 1\.4\.2/);
    assert.match(markdown, /Secant version: 0\.1\.0/);
    assert.match(markdown, new RegExp(`Binary SHA-256: ${digest}`));
    assert.match(markdown, /Outcome: pass/);
    assert.match(markdown, /UTC timestamp: 2026-09-19T12:34:56\.000Z/);
  }
});

test("[release-evidence-contract] reviewer checklist binds candidate identity, gates, reports, claims, and approval", () => {
  const checklist = readFileSync("docs/release-checklist.md", "utf8");
  for (const required of [
    "Ref/tag:",
    "Commit:",
    "Workflow run:",
    "Secant version:",
    "Candidate digests:",
    "Automated gates",
    "Installed Claude Code report",
    "Installed Codex report",
    "Windows Terminal basis:",
    "Support-matrix change:",
    "Public-use evidence:",
    "Final reviewer:",
    "Approval UTC timestamp:",
  ]) {
    assert.match(checklist, new RegExp(required));
  }

  const supportMatrix = readFileSync("docs/support-matrix.md", "utf8");
  assert.match(supportMatrix, /## Operating systems and architectures/);
  assert.match(supportMatrix, /## Terminals/);
  assert.match(supportMatrix, /## Harnesses/);
  assert.match(supportMatrix, /do \*\*not\*\* prove/);
});

test("[release-evidence-contract] invalid digests, timestamps, and subject kinds fail closed", () => {
  assert.throws(
    () =>
      parseReleaseEvidenceReport({
        ...report({ kind: "harness", name: "Codex", version: "0.42.0" }),
        binarySha256: "old-build",
      }),
    /binarySha256/,
  );
  assert.throws(
    () =>
      parseReleaseEvidenceReport({
        ...report({ kind: "harness", name: "Codex", version: "0.42.0" }),
        timestamp: "today",
      }),
    /timestamp/,
  );
  assert.throws(
    () =>
      parseReleaseEvidenceReport({
        ...report({ kind: "harness", name: "Codex", version: "0.42.0" }),
        subject: { kind: "replay", name: "Codex", version: "fixture" },
      }),
    /subject.kind/,
  );
});

test("[release-evidence-contract] Windows Terminal names fresh and carry-forward evidence without changing the common header", () => {
  const common = report({
    kind: "terminal",
    name: "Windows Terminal",
    version: "1.24.10393.0",
  });
  const observations = {
    quitBindingPassed: true,
    ctrlCPassed: true,
    conhostNoticeAppeared: true,
    conhostNoticeReadable: false,
    conhostWindowSurvived: false,
  };

  const fresh = formatWindowsTerminalReport({
    report: common,
    evidence: { kind: "fresh" },
    ...observations,
  });
  assert.match(fresh, /Evidence basis: fresh real-terminal check/);

  const carried = formatWindowsTerminalReport({
    report: common,
    evidence: {
      kind: "carry-forward",
      report: "v0.1.0 Windows Terminal report",
      comparison: "v0.1.1 terminal-trigger comparison",
    },
    ...observations,
  });
  assert.match(
    carried,
    /Evidence basis: carry-forward from v0\.1\.0 Windows Terminal report/,
  );
  assert.match(
    carried,
    /Named comparison: v0\.1\.1 terminal-trigger comparison/,
  );
  assert.throws(
    () =>
      formatWindowsTerminalReport({
        report: common,
        evidence: { kind: "carry-forward", report: "", comparison: "" },
        ...observations,
      }),
    /named prior report and comparison/,
  );
});

test("[release-evidence-contract] installed Harness outcome requires repair, authored gate, and only a post-approval commit", () => {
  const passingObservations = {
    repairPassed: true,
    authoredGateReached: true,
    committedBeforeApproval: false,
    runSucceededAfterApproval: true,
    postApprovalCommitObserved: true,
  };
  const passed = evaluateProofBundleEvidence(passingObservations);
  assert.equal(passed.outcome, "pass");
  assert.equal(
    formatInstalledHarnessDetails(passed),
    `### External Proof Bundle observations

| Observation | Result |
| --- | --- |
| Test repair | pass |
| Authored approve-commit gate | pass |
| Commit absent before approval | pass |
| Run succeeded after approval | pass |
| Post-approval commit | pass |`,
  );

  const failingObservations = [
    { ...passingObservations, repairPassed: false },
    { ...passingObservations, authoredGateReached: false },
    { ...passingObservations, committedBeforeApproval: true },
    { ...passingObservations, runSucceededAfterApproval: false },
    { ...passingObservations, postApprovalCommitObserved: false },
  ];
  for (const observations of failingObservations) {
    assert.equal(evaluateProofBundleEvidence(observations).outcome, "fail");
  }
});

test("[release-evidence-contract] failed installed-Harness reports retain launch diagnostics on every OS", () => {
  const operatingSystems = [
    { name: "Windows", version: "11 (10.0.26200)" },
    { name: "macOS", version: "15.6 (24G84)" },
    { name: "Linux", version: "6.8.0-31-generic" },
  ];
  const evidence = evaluateProofBundleEvidence({
    repairPassed: false,
    authoredGateReached: false,
    committedBeforeApproval: false,
    runSucceededAfterApproval: false,
    postApprovalCommitObserved: false,
  });
  const problem = parseInstalledHarnessProblem({
    code: "command-executable-not-found",
    explanation: "baseline-test needs missing-command.",
    remediation: "Install missing-command and launch again.",
  });
  const transcript = parseTerminalHarnessDiagnostic({
    page: {
      entries: [
        { role: "assistant", content: "an earlier response" },
        { role: "user", content: "repair the test" },
      ],
    },
    export: {
      entries: [
        { role: "assistant", content: "an earlier response" },
        {
          role: "assistant",
          content: "You have no weighted tokens left\nuntil Monday.",
        },
      ],
    },
  });

  assert.deepEqual(problem, {
    code: "command-executable-not-found",
    explanation: "baseline-test needs missing-command.",
    remediation: "Install missing-command and launch again.",
  });
  assert.equal(transcript, "You have no weighted tokens left\nuntil Monday.");
  assert.equal(
    parseInstalledHarnessProblem({
      code: "command-executable-not-found",
      explanation: "missing remediation",
    }),
    undefined,
  );
  assert.equal(
    parseTerminalHarnessDiagnostic({
      page: { entries: [{ role: "assistant", content: "page fallback" }] },
    }),
    "page fallback",
  );
  assert.equal(
    parseTerminalHarnessDiagnostic({
      export: { entries: [{ role: "user", content: "no assistant" }] },
    }),
    undefined,
  );
  assert.deepEqual(observedHarnessForReport("Claude Code", undefined, "fail"), {
    name: "Claude Code",
    version: "not observed",
  });

  for (const operatingSystem of operatingSystems) {
    const formatted = formatReleaseEvidenceReport({
      ...report({
        kind: "harness",
        name: "Claude Code",
        version: "not observed",
      }),
      operatingSystem,
      outcome: evidence.outcome,
    });
    const details = formatInstalledHarnessDetails(evidence, {
      launch: {
        status: 1,
        stdout:
          '{"code":"command-executable-not-found","detail":"left|right"}\n',
        stderr: "",
      },
      postApprovalRun: {
        status: 2,
        stdout: '{"result":{"run":{"state":"failed"}}}\n',
        stderr: "run answer failed\n",
      },
      commitVerdict: { status: 0, stdout: "fail\n", stderr: "" },
      commitOutput: {
        status: 0,
        stdout: "commit command failed\n",
        stderr: "",
      },
      problem,
      transcript,
    });

    assert.match(
      formatted,
      new RegExp(`OS and version: ${operatingSystem.name}`),
    );
    assert.match(formatted, /Harness: Claude Code not observed/);
    assert.match(formatted, /Outcome: fail/);
    assert.match(details, /### Failed installed-Harness diagnostics/);
    assert.match(details, /Launch exit status \| 1/);
    assert.match(details, /Problem code \| command-executable-not-found/);
    assert.match(
      details,
      /Problem explanation \| baseline-test needs missing-command\./,
    );
    assert.match(
      details,
      /Problem remediation \| Install missing-command and launch again\./,
    );
    assert.match(
      details,
      /Launch stdout \| \{"code":"command-executable-not-found","detail":"left\\\|right"\}<br>/,
    );
    assert.match(details, /You have no weighted tokens left<br>until Monday\./);
    assert.match(details, /Launch stderr \| \(empty\)/);
    assert.match(details, /Post-approval run exit status \| 2/);
    assert.match(
      details,
      /Post-approval run stdout \| \{"result":\{"run":\{"state":"failed"\}\}\}<br>/,
    );
    assert.match(details, /Post-approval run stderr \| run answer failed<br>/);
    assert.match(details, /Commit verdict read exit status \| 0/);
    assert.match(details, /Captured commit verdict \| fail<br>/);
    assert.match(details, /Commit output read exit status \| 0/);
    assert.match(
      details,
      /Captured commit stdout\/stderr \| commit command failed<br>/,
    );
  }
});

test("[release-evidence-contract] an installed-Harness report requires observed name and version", () => {
  assert.deepEqual(
    parseObservedHarnessIdentity({
      name: "Claude Code",
      executableVersion: "2.1.273",
    }),
    { name: "Claude Code", version: "2.1.273" },
  );
  for (const invalid of [
    undefined,
    { name: "Claude Code" },
    { name: "Claude Code", executableVersion: "" },
    { name: "", executableVersion: "2.1.273" },
  ]) {
    assert.throws(() => parseObservedHarnessIdentity(invalid), /observed/);
  }
  assert.throws(
    () => observedHarnessForReport("Codex", undefined, "pass"),
    /observed/,
  );
});
