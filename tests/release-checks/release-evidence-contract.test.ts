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
  parseObservedHarnessIdentity,
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
  assert.match(formatInstalledHarnessDetails(passed), /Test repair \| pass/);
  assert.match(
    formatInstalledHarnessDetails(passed),
    /Authored approve-commit gate \| pass/,
  );
  assert.match(
    formatInstalledHarnessDetails(passed),
    /Post-approval commit \| pass/,
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
});
