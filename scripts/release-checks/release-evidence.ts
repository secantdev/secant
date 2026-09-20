import { fail, record, text } from "../release-helpers.js";

export type EvidenceSubject =
  | {
      readonly kind: "terminal";
      readonly name: string;
      readonly version: string;
    }
  | {
      readonly kind: "harness";
      readonly name: string;
      readonly version: string;
    };

export interface ReleaseEvidenceReport {
  readonly checkName: string;
  readonly operatingSystem: {
    readonly name: string;
    readonly version: string;
  };
  readonly subject: EvidenceSubject;
  readonly bunVersion: string;
  readonly secantVersion: string;
  readonly binarySha256: string;
  readonly outcome: "pass" | "fail";
  readonly timestamp: string;
}

const FIELD_ERROR = "Invalid release evidence field";

function evidenceRecord(value: unknown, field: string) {
  return record({ value, field, errorPrefix: FIELD_ERROR });
}

function evidenceText(value: unknown, field: string): string {
  return text({
    value,
    field,
    errorPrefix: FIELD_ERROR,
    rejectWhitespace: true,
  });
}

function invalidField(field: string): never {
  return fail(`${FIELD_ERROR}: ${field}.`);
}

/** Validate evidence arriving from a saved report before it can support a claim. */
export function parseReleaseEvidenceReport(
  value: unknown,
): ReleaseEvidenceReport {
  const input = evidenceRecord(value, "report");
  const operatingSystem = evidenceRecord(
    input.operatingSystem,
    "operatingSystem",
  );
  const subject = evidenceRecord(input.subject, "subject");
  const kind = subject.kind;
  if (kind !== "terminal" && kind !== "harness") invalidField("subject.kind");
  const binarySha256 = evidenceText(input.binarySha256, "binarySha256");
  if (!/^[0-9a-f]{64}$/.test(binarySha256)) invalidField("binarySha256");
  const outcome = input.outcome;
  if (outcome !== "pass" && outcome !== "fail") invalidField("outcome");
  const timestamp = evidenceText(input.timestamp, "timestamp");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    invalidField("timestamp");
  }

  return {
    checkName: evidenceText(input.checkName, "checkName"),
    operatingSystem: {
      name: evidenceText(operatingSystem.name, "operatingSystem.name"),
      version: evidenceText(operatingSystem.version, "operatingSystem.version"),
    },
    subject: {
      kind,
      name: evidenceText(subject.name, "subject.name"),
      version: evidenceText(subject.version, "subject.version"),
    },
    bunVersion: evidenceText(input.bunVersion, "bunVersion"),
    secantVersion: evidenceText(input.secantVersion, "secantVersion"),
    binarySha256,
    outcome,
    timestamp,
  };
}

/** The one reviewer-visible header shared by every human release check. */
export function formatReleaseEvidenceReport(
  value: ReleaseEvidenceReport,
): string {
  const report = parseReleaseEvidenceReport(value);
  const subjectLabel =
    report.subject.kind === "terminal" ? "Terminal" : "Harness";
  return `## ${report.checkName}

- Check name: ${report.checkName}
- OS and version: ${report.operatingSystem.name} ${report.operatingSystem.version}
- ${subjectLabel}: ${report.subject.name} ${report.subject.version}
- Bun version: ${report.bunVersion}
- Secant version: ${report.secantVersion}
- Binary SHA-256: ${report.binarySha256}
- Outcome: ${report.outcome}
- UTC timestamp: ${report.timestamp}`;
}
