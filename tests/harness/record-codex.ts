// Opt-in Codex recorder. It drives the production Adapter and observes the exact
// schema, ordered JSONL/stderr bytes, controls, shutdown, and Workspace effect
// through the recorder-only native seam. It requires an installed Codex and, for
// conversational cases, the user's existing Codex authentication.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  type HarnessRequest,
  type HarnessTurn,
  type RecoveryCoordinate,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from "../../src/harness/harness.js";
import { createCodexAdapter } from "./test-adapters.js";
import {
  assertNoCredentials,
  envSecrets,
  redact,
  type KnownSecret,
  type Redaction,
} from "./redact.js";
import {
  CODEX_RECORDING_INPUT,
  codexTestRepairPrompt,
} from "./codex-recording-cases.js";
import {
  createCodexRecordingCapture,
  type CodexRecordingCapture,
  type CodexTrafficDirection,
} from "./codex-recording.js";
import { seedTestRepairWorkspace } from "../helpers/testRepairWorkspace.js";

const FIXTURE_ROOT = join(import.meta.dirname, "fixtures", "codex");
const REFRESH_COMMAND = "bun tests/harness/record-codex.ts";
const recorderTempDirectories: string[] = [];
const REAL_CASES = new Set([
  "codex-qualification",
  "completion",
  "two-turns",
  "approval",
  "steer",
  "interrupt",
  "resume",
  "authentication",
  "test-repair",
]);

process.on("exit", () => {
  for (const directory of recorderTempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function recorderTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  recorderTempDirectories.push(directory);
  return directory;
}

interface TMutableTrafficEntry {
  direction: CodexTrafficDirection | "workspace-patch";
  line?: string;
  path?: string;
}

const requested = process.argv[2] ?? "codex-qualification";
const caseName =
  requested === "qualification" ? "codex-qualification" : requested;
if (!REAL_CASES.has(caseName)) {
  throw new Error(
    `Unknown Codex recording case '${requested}'. Expected one of: ${[...REAL_CASES].join(", ")}.`,
  );
}

const workspace = recorderTempDir(`secant-codex-${caseName}-`);
if (caseName === "authentication") {
  process.env.CODEX_HOME = recorderTempDir(
    "secant-codex-unauthenticated-home-",
  );
}
const capture = createCodexRecordingCapture();
const prepared = await createCodexAdapter({
  recordingObserver: capture.observer,
}).prepare({
  workspace,
  ...(caseName === "approval"
    ? { configuredExecutable: approvalExecutable() }
    : {}),
});

if (caseName === "authentication") {
  if (prepared.ok || prepared.failure.category !== "authentication") {
    if (prepared.ok) await prepared.harness.close();
    throw new Error(
      "The authentication case requires an unauthenticated Codex home. Run with CODEX_HOME set to an empty temporary directory.",
    );
  }
  writeRecording({
    caseName,
    workspace,
    capture,
  });
  process.stdout.write(`Recorded ${caseName}.\n`);
  process.exit(0);
}

if (!prepared.ok) {
  throw new Error(
    `The production Codex Adapter did not qualify this install: ${prepared.failure.diagnostics ?? prepared.failure.category}`,
    { cause: prepared.failure.cause },
  );
}

let workspacePatch: string | undefined;
if (caseName !== "codex-qualification") {
  if (caseName === "test-repair") seedTestRepairWorkspace(workspace);
  await driveCase(caseName, prepared.harness.startTurn.bind(prepared.harness));
  if (caseName === "test-repair") {
    workspacePatch = git(workspace, ["diff", "--binary"]);
    if (workspacePatch.length === 0) {
      throw new Error(
        "The Codex Test Repair recording produced no Workspace patch.",
      );
    }
  }
}

const cleanup = await prepared.harness.close();
if (!cleanup.clean) {
  throw new Error("The production Codex Adapter did not close cleanly.", {
    cause: cleanup.failure?.cause,
  });
}
if (capture.schema === undefined) {
  throw new Error(
    "The production Codex Adapter produced no schema observation.",
  );
}
if (capture.exit?.kind !== "exited" || capture.exit.status !== 0) {
  throw new Error(
    "The production Codex Adapter produced no clean exit observation.",
  );
}

writeRecording({
  caseName,
  workspace,
  capture,
  workspacePatch,
});
process.stdout.write(
  `Recorded ${caseName} from ${prepared.harness.profile.executableVersion}.\n`,
);

async function driveCase(
  name: string,
  startTurn: (request: TurnRequest) => HarnessTurn,
): Promise<void> {
  switch (name) {
    case "completion":
      await expectResult(
        startTurn,
        turnRequest("completion", CODEX_RECORDING_INPUT.completion),
        "completed",
      );
      return;
    case "two-turns":
      await expectResult(
        startTurn,
        turnRequest("two-turns", CODEX_RECORDING_INPUT.completion),
        "completed",
      );
      await expectResult(
        startTurn,
        turnRequest("two-turns", CODEX_RECORDING_INPUT.secondCompletion),
        "completed",
      );
      return;
    case "approval": {
      const turn = startTurn(
        turnRequest("approval", CODEX_RECORDING_INPUT.approval),
      );
      await answerApproval(turn, await firstRequest(turn), "allow");
      await expectTurnResult(turn, "completed");
      return;
    }
    case "steer": {
      const turn = startTurn(turnRequest("steer", CODEX_RECORDING_INPUT.steer));
      await firstSession(turn);
      const receipt = await turn.steer({
        text: CODEX_RECORDING_INPUT.steerGuidance,
      });
      if (receipt.outcome !== "accepted") {
        throw new Error(
          `Codex rejected the recording Steer: ${receipt.reason}.`,
        );
      }
      await expectTurnResult(turn, "completed");
      return;
    }
    case "interrupt": {
      const turn = startTurn(
        turnRequest("interrupt", CODEX_RECORDING_INPUT.sleep),
      );
      await firstEvent(
        turn,
        (event) =>
          event.kind === "tool-activity" || event.kind === "request-raised",
      );
      const receipt = await turn.interrupt();
      if (receipt.outcome !== "accepted") {
        throw new Error(
          `Codex rejected the recording Interrupt: ${receipt.reason}.`,
        );
      }
      await expectTurnResult(turn, "interrupted");
      return;
    }
    case "resume": {
      const first = startTurn(
        turnRequest("resume", CODEX_RECORDING_INPUT.sleep),
      );
      await firstEvent(
        first,
        (event) =>
          event.kind === "tool-activity" || event.kind === "request-raised",
      );
      const receipt = await first.interrupt();
      if (receipt.outcome !== "accepted") {
        throw new Error("Codex rejected the resume-case Interrupt.");
      }
      const coordinate = detachedCoordinate(
        await expectTurnResult(first, "interrupted"),
      );
      await expectResult(
        startTurn,
        turnRequest("resume", CODEX_RECORDING_INPUT.resume, coordinate),
        "completed",
      );
      return;
    }
    case "test-repair": {
      const turn = startTurn(
        turnRequest("test-repair", codexTestRepairPrompt(workspace)),
      );
      const result = answerEveryApproval(turn);
      await expectTurnResult(turn, "completed");
      await result;
      execFileSync(process.execPath, ["test", "sum.test.mjs"], {
        cwd: workspace,
        stdio: "pipe",
      });
      return;
    }
    default:
      throw new Error(`No Turn driver for '${name}'.`);
  }
}

function turnRequest(
  session: string,
  text: string,
  resume?: RecoveryCoordinate,
): TurnRequest {
  return {
    session,
    origin: "managed",
    correlationKey: { opaque: `record-${session}` },
    input: { text },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
    ...(resume === undefined ? {} : { resume }),
  };
}

async function expectResult(
  startTurn: (request: TurnRequest) => HarnessTurn,
  request: TurnRequest,
  kind: TurnResult["kind"],
): Promise<TurnResult> {
  return expectTurnResult(startTurn(request), kind);
}

async function expectTurnResult(
  turn: HarnessTurn,
  kind: TurnResult["kind"],
): Promise<TurnResult> {
  const result = await turn.result();
  if (result.kind !== kind) {
    throw new Error(
      `Recorded Codex Turn settled '${result.kind}', expected '${kind}'.`,
    );
  }
  return result;
}

function detachedCoordinate(result: TurnResult): RecoveryCoordinate {
  if (
    result.kind !== "interrupted" ||
    result.detail.session.state !== "detached"
  ) {
    throw new Error("The resume recording did not produce a detached Session.");
  }
  return result.detail.session.coordinate;
}

function firstSession(turn: HarnessTurn): Promise<void> {
  return firstEvent(turn, (event) => event.kind === "session").then(
    () => undefined,
  );
}

async function firstRequest(turn: HarnessTurn): Promise<HarnessRequest> {
  const event = await Promise.race([
    firstEvent(turn, (candidate) => candidate.kind === "request-raised"),
    turn.result().then((result) => {
      throw new Error(
        `Codex settled '${result.kind}' before raising the recording approval.`,
      );
    }),
  ]);
  if (event.kind !== "request-raised") throw new Error("unreachable");
  return event.request;
}

function firstEvent(
  turn: HarnessTurn,
  matches: (event: TurnEvent) => boolean,
): Promise<TurnEvent> {
  return new Promise((resolve) => {
    const subscription = turn.subscribe((event) => {
      if (!matches(event)) return;
      subscription.unsubscribe();
      resolve(event);
    });
  });
}

async function answerApproval(
  turn: HarnessTurn,
  request: HarnessRequest,
  decision: "allow" | "deny",
): Promise<void> {
  if (request.shape.kind !== "approval") {
    throw new Error("Codex raised a non-approval request while recording.");
  }
  const receipt = await turn.answerRequest({
    requestId: request.requestId,
    kind: "approval",
    decision,
  });
  if (receipt.outcome !== "accepted") {
    throw new Error(
      `Codex rejected the recorded approval answer: ${receipt.reason}.`,
    );
  }
}

async function answerEveryApproval(turn: HarnessTurn): Promise<void> {
  const answers: Promise<void>[] = [];
  turn.subscribe((event) => {
    if (event.kind === "request-raised") {
      answers.push(answerApproval(turn, event.request, "allow"));
    }
  });
  await turn.result();
  await Promise.all(answers);
}

function git(directory: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: directory,
    encoding: "utf8",
  });
}

function writeRecording(options: {
  readonly caseName: string;
  readonly workspace: string;
  readonly capture: CodexRecordingCapture;
  readonly workspacePatch?: string;
}): void {
  const directory = join(FIXTURE_ROOT, options.caseName);
  mkdirSync(directory, { recursive: true });
  const traffic: TMutableTrafficEntry[] = options.capture.traffic.map(
    (entry) => ({ direction: entry.direction, line: entry.line }),
  );
  if (options.workspacePatch !== undefined) {
    const terminalAt = terminalTrafficIndex(traffic);
    if (terminalAt < 0) {
      throw new Error("The recording has no terminal Turn event.");
    }
    traffic.splice(terminalAt, 0, {
      direction: "workspace-patch",
      path: "workspace.patch",
    });
  }

  const rawCase = `${JSON.stringify(
    {
      replay: "strict",
      traffic,
      ...(options.caseName === "codex-qualification"
        ? { responses: qualificationResponses(traffic) }
        : {}),
      exitCode: options.capture.exit?.status ?? 0,
    },
    null,
    2,
  )}\n`;
  const redactedCase = redact(
    rawCase,
    recordingSecrets(rawCase, options.workspace),
  );
  const sidecar = `${JSON.stringify(
    {
      harness: "codex",
      executableVersion: requiredProvenance(
        "executable version",
        options.capture.executableVersion,
      ),
      protocolVersion: requiredProvenance(
        "protocol version",
        options.capture.protocolVersion,
      ),
      recordedAt: new Date().toISOString(),
      redactions: mergeRedactions(redactedCase.redactions),
      refreshCommand: `${REFRESH_COMMAND} ${options.caseName}`,
    },
    null,
    2,
  )}\n`;
  for (const text of [
    redactedCase.text,
    sidecar,
    options.capture.schema,
    options.workspacePatch,
  ]) {
    if (text !== undefined) assertNoCredentials(text);
  }
  writeFileSync(join(directory, "case.json"), redactedCase.text);
  writeFileSync(join(directory, "recording.json"), sidecar);
  if (options.workspacePatch !== undefined) {
    writeFileSync(join(directory, "workspace.patch"), options.workspacePatch);
  }
  if (
    options.caseName === "codex-qualification" &&
    options.capture.schema !== undefined
  ) {
    writeFileSync(
      join(directory, "stable-schema.generated.json"),
      options.capture.schema,
    );
  }
}

function qualificationResponses(
  traffic: readonly TMutableTrafficEntry[],
): Record<string, { readonly line: string }> {
  return Object.fromEntries(
    [
      ["initialize", 1],
      ["account/read", 2],
      ["model/list", 3],
    ].map(([method, id]) => {
      const entry = traffic.find((candidate) => {
        if (candidate.direction !== "stdout" || candidate.line === undefined) {
          return false;
        }
        try {
          return JSON.parse(candidate.line).id === id;
        } catch {
          return false;
        }
      });
      if (entry?.line === undefined) {
        throw new Error(`${method} recording response is missing.`);
      }
      return [method, { line: entry.line }];
    }),
  );
}

function terminalTrafficIndex(
  traffic: readonly TMutableTrafficEntry[],
): number {
  for (let index = traffic.length - 1; index >= 0; index -= 1) {
    const entry = traffic[index];
    if (entry?.direction !== "stdout" || entry.line === undefined) continue;
    try {
      if (JSON.parse(entry.line).method === "turn/completed") return index;
    } catch {
      // A corruption case may deliberately contain malformed protocol bytes.
    }
  }
  return -1;
}

function recordingSecrets(
  caseText: string,
  workspacePath: string,
): KnownSecret[] {
  const secrets: KnownSecret[] = [
    {
      value: workspacePath,
      placeholder: "«WORKSPACE»",
      reason: "recording Workspace path",
    },
    { value: homedir(), placeholder: "«HOME»", reason: "user home path" },
    {
      value: hostname(),
      placeholder: "«HOSTNAME»",
      reason: "recording host name",
    },
    {
      value: userInfo().username,
      placeholder: "«USER»",
      reason: "operating-system user name",
    },
    ...envSecrets(),
  ];
  for (const entry of JSON.parse(caseText).traffic as TMutableTrafficEntry[]) {
    if (entry.line === undefined) continue;
    try {
      const message = JSON.parse(entry.line);
      const codexHome = message.result?.codexHome;
      const email = message.result?.account?.email;
      const installationId = message.params?.installationId;
      if (typeof codexHome === "string") {
        secrets.push({
          value: codexHome,
          placeholder: "/recorded/codex-home",
          reason: "Codex home path",
        });
      }
      if (typeof email === "string") {
        secrets.push({
          value: email,
          placeholder: "recorded@example.invalid",
          reason: "Codex account email",
        });
      }
      if (typeof installationId === "string") {
        secrets.push({
          value: installationId,
          placeholder: "recorded-installation-id",
          reason: "Codex installation id",
        });
      }
    } catch {
      // A corruption case may deliberately contain malformed protocol bytes.
    }
  }
  return secrets;
}

function mergeRedactions(redactions: readonly Redaction[]): Redaction[] {
  return redactions.filter(
    (entry, index) =>
      redactions.findIndex(
        (candidate) => candidate.placeholder === entry.placeholder,
      ) === index,
  );
}

function requiredProvenance(label: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`The production Codex Adapter observed no ${label}.`);
  }
  return value;
}

function approvalExecutable(): string {
  if (process.platform === "win32") {
    throw new Error(
      "Refresh the real Codex approval recording on macOS or Linux; replay remains cross-platform.",
    );
  }
  const executable = execFileSync("which", ["codex"], {
    encoding: "utf8",
  }).trim();
  const directory = recorderTempDir("secant-codex-user-reviewer-");
  const wrapper = join(directory, "codex-user-reviewer");
  const quoted = `'${executable.replaceAll("'", `'\\''`)}'`;
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${quoted} -c approvals_reviewer=user "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}
