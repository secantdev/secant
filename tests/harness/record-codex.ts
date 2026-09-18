// Opt-in recorder for Codex's non-conversational qualification case. It drives
// the production Adapter with a recorder-only byte observer, so the generated
// stable schema and ordered JSONL bytes are exactly what `prepare` consumed.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCodexAdapter,
  type CodexQualificationObserver,
} from "../../src/harness/harness.js";
import { assertNoCredentials } from "./redact.js";

const FIXTURE_DIRECTORY = join(
  import.meta.dirname,
  "fixtures",
  "codex",
  "codex-qualification",
);
const PROBE_REVISION = "codex-probe-2";
const CODEX_HOME_PLACEHOLDER = "/recorded/codex-home";
const ACCOUNT_EMAIL_PLACEHOLDER = "recorded@example.invalid";

type TDirection = "stdin" | "stdout";

interface TTrafficEntry {
  readonly direction: TDirection;
  readonly line: string;
}

interface TRedactedRecording {
  readonly traffic: readonly TTrafficEntry[];
  readonly redactions: readonly {
    readonly placeholder: string;
    readonly reason: string;
  }[];
}

const observedTraffic: TTrafficEntry[] = [];
let generatedSchema: string | undefined;
let recordedExit:
  { readonly kind: string; readonly status: number | undefined } | undefined;
const decoder = new TextDecoder();
const observer: CodexQualificationObserver = {
  schema(schema) {
    generatedSchema = schema;
  },
  stdin(bytes) {
    observedTraffic.push({ direction: "stdin", line: decoder.decode(bytes) });
  },
  stdout(bytes) {
    observedTraffic.push({ direction: "stdout", line: decoder.decode(bytes) });
  },
  closed(kind, status) {
    recordedExit = { kind, status };
  },
};

const prepared = await createCodexAdapter({
  qualificationObserver: observer,
}).prepare({ workspace: process.cwd() });
if (!prepared.ok) {
  throw new Error(
    "The production Codex Adapter did not qualify this install.",
    {
      cause: prepared.failure.cause,
    },
  );
}
const cleanup = await prepared.harness.close();
if (!cleanup.clean) {
  throw new Error("The production Codex Adapter did not close cleanly.", {
    cause: cleanup.failure?.cause,
  });
}
if (generatedSchema === undefined) {
  throw new Error(
    "The production Codex Adapter produced no schema observation.",
  );
}
if (recordedExit?.kind !== "exited" || recordedExit.status !== 0) {
  throw new Error(
    "The production Codex Adapter produced no clean exit observation.",
  );
}

const redacted = redactRecording(observedTraffic);
const responses = {
  initialize: { line: responseLine(redacted.traffic, 1, "initialize") },
  "account/read": { line: responseLine(redacted.traffic, 2, "account/read") },
  "model/list": { line: responseLine(redacted.traffic, 3, "model/list") },
};
const caseText = `${JSON.stringify(
  { traffic: redacted.traffic, responses, exitCode: recordedExit.status },
  null,
  2,
)}\n`;
const sidecarText = `${JSON.stringify(
  {
    harness: "codex",
    executableVersion: prepared.harness.profile.executableVersion,
    protocolVersion: PROBE_REVISION,
    recordedAt: new Date().toISOString(),
    redactions: redacted.redactions,
    refreshCommand: "bun tests/harness/record-codex.ts",
  },
  null,
  2,
)}\n`;
assertNoCredentials(caseText);
assertNoCredentials(sidecarText);
assertNoCredentials(generatedSchema);
writeFileSync(
  join(FIXTURE_DIRECTORY, "stable-schema.generated.json"),
  generatedSchema,
);
writeFileSync(join(FIXTURE_DIRECTORY, "case.json"), caseText);
writeFileSync(join(FIXTURE_DIRECTORY, "recording.json"), sidecarText);
process.stdout.write(
  `Recorded codex-qualification from ${prepared.harness.profile.executableVersion}.\n`,
);

function redactRecording(
  traffic: readonly TTrafficEntry[],
): TRedactedRecording {
  const initialize = responseObject(traffic, 1, "initialize");
  const account = responseObject(traffic, 2, "account/read");
  const codexHome = initialize.codexHome;
  if (typeof codexHome !== "string") {
    throw new Error("Initialize response did not contain codexHome.");
  }
  const replacements = new Map<string, string>([
    [codexHome, CODEX_HOME_PLACEHOLDER],
  ]);
  const redactions = [
    { placeholder: CODEX_HOME_PLACEHOLDER, reason: "Codex home" },
  ];
  const accountValue = account.account;
  if (isRecord(accountValue) && typeof accountValue.email === "string") {
    replacements.set(accountValue.email, ACCOUNT_EMAIL_PLACEHOLDER);
    redactions.push({
      placeholder: ACCOUNT_EMAIL_PLACEHOLDER,
      reason: "account email",
    });
  }
  return {
    traffic: traffic.map((entry) => ({
      direction: entry.direction,
      line: replaceJsonStrings(entry.line, replacements),
    })),
    redactions,
  };
}

function responseObject(
  traffic: readonly TTrafficEntry[],
  id: number,
  method: string,
): Record<string, unknown> {
  const line = responseLine(traffic, id, method);
  const message = JSON.parse(line);
  if (!isRecord(message) || !isRecord(message.result)) {
    throw new Error(`${method} recording response has no result.`);
  }
  return message.result;
}

function responseLine(
  traffic: readonly TTrafficEntry[],
  id: number,
  method: string,
): string {
  const response = traffic.find((entry) => {
    if (entry.direction !== "stdout") return false;
    const message = JSON.parse(entry.line);
    return isRecord(message) && message.id === id;
  });
  if (response === undefined) {
    throw new Error(`${method} recording response is missing.`);
  }
  return response.line;
}

function replaceJsonStrings(
  text: string,
  replacements: ReadonlyMap<string, string>,
): string {
  let redacted = text;
  for (const [value, replacement] of replacements) {
    redacted = redacted.replaceAll(
      JSON.stringify(value),
      JSON.stringify(replacement),
    );
  }
  return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
