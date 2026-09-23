// Runtime-only installer for the recorded Codex replayer. Like the Claude
// replayer-install.ts, it deliberately has no node:test dependency so
// package-smoke.ts can install the same fake from a plain Bun process; the
// test-runner wrapper codex-replayer.ts adds temporary-directory cleanup.

import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(
  dirname(fileURLToPath(import.meta.url)),
  "codex-replayer.mjs",
);
const replayPathSource = join(
  dirname(fileURLToPath(import.meta.url)),
  "codex-replay-path.ts",
);
const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "codex",
);
const qualificationFixtureDirectory = join(fixtureRoot, "codex-qualification");
const SCHEMA_FILE = "stable-schema.generated.json";
// Staged once per process on the temp volume. Node:test-free, so it is not
// registered for test-runner cleanup; it is one small directory the OS reclaims.
const sharedSchemaDirectory = mkdtempSync(
  join(tmpdir(), "secant-codex-schema-source-"),
);
// Stage the immutable schema on the temp volume once. Normal qualification
// cases then copy temp-to-temp; mutation cases still take an isolated copy.
copyFileSync(
  join(qualificationFixtureDirectory, SCHEMA_FILE),
  join(sharedSchemaDirectory, SCHEMA_FILE),
);

export interface CodexInvocation {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdinLines: readonly string[];
}

export interface InstalledCodexReplayer {
  readonly executablePath: string;
  readonly identityPath: string;
  readonly windowsShimPath: string;
  readonly path: string;
  invocations(): readonly CodexInvocation[];
  drift(version: string): void;
  driftBytesWithoutMetadataChange(): void;
  changeVersionOnly(version: string): void;
  removeSchemaMethod(method: string): void;
  changeTurnStatusShape(): void;
  changeApprovalSchemaShape(
    field:
      | "path"
      | "kind"
      | "move-path"
      | "file-items"
      | "command"
      | "command-kind"
      | "resolved-id"
      | "resolved-thread"
      | "command-kind-values"
      | "request-id-types"
      | "server-request-id",
  ): void;
  corruptSchema(): void;
  failVersion(status: number): void;
  failCleanup(status: number): void;
  removeResponseField(method: string, field: string): void;
  requireLogin(): void;
  failTurn(message: string): void;
  configureTurn(options: CodexTurnReplayOptions): void;
  configureRecovery(options: CodexRecoveryReplayOptions): void;
}

export interface CodexTurnReplayOptions {
  /** Acknowledge workspace-write without the requested writable root (#214). */
  readonly ignoreWritableRoots?: boolean;
  readonly stopAfter?: "accepted" | "item-completed";
  readonly terminalLineEnding?: "crlf";
  readonly truncatedFrame?: boolean;
  readonly fullActivity?: boolean;
  readonly retryingError?: string;
  readonly mismatchedTerminal?: boolean;
  readonly malformedFrame?: boolean;
  readonly stallFirstTurn?: boolean;
  readonly malformedItem?: boolean;
  readonly malformedTerminal?: boolean;
  readonly approvals?: readonly CodexApprovalReplay[];
  readonly resolveFirstApproval?: boolean;
  readonly completeWithOutstandingApproval?: boolean;
  readonly duplicateFirstApproval?: boolean;
  readonly withholdTerminal?: boolean;
  readonly interruptTerminal?: "interrupted" | "exit";
  readonly steerTerminal?: "completed";
  readonly interruptRpcError?: "stale" | "mismatch" | "near-miss" | "internal";
  readonly interruptTerminalBeforeResponse?:
    "completed" | "failed" | "interrupted";
  readonly stallInterruptResponse?: boolean;
  readonly stallSteerResponse?: boolean;
  readonly stallSecondSteerResponse?: boolean;
  readonly mismatchedSteerResponse?: boolean;
  readonly malformedSteerResponse?: boolean;
  readonly malformedInterruptResponse?: boolean;
  readonly steerRpcError?:
    | "no-active"
    | "mismatch"
    | "empty"
    | "review"
    | "compact"
    | "schema"
    | "near-miss";
}

export interface CodexApprovalReplay {
  readonly id: string | number;
  readonly kind:
    "command" | "file" | "unsupported-command" | "request-user-input";
  readonly itemId: string;
  readonly command?: string;
  readonly changes?: readonly {
    readonly path: string;
    readonly kind: "add" | "delete" | "update";
    readonly movePath?: string;
  }[];
}

export interface CodexRecoveryReplayOptions {
  readonly threadId?: string | null;
  readonly malformedFrame?: boolean;
}

function npmBunShim(scriptRelative: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\bun.exe" (',
    '  SET "_prog=%dp0%\\bun.exe"',
    ") ELSE (",
    '  SET "_prog=bun"',
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${scriptRelative}" %*`,
  ].join("\r\n");
}

function readInvocations(logPath: string): readonly CodexInvocation[] {
  const text = readFileSync(logPath, "utf8").trim();
  if (text.length === 0) return [];
  const entries = text.split("\n").map((line) => JSON.parse(line));
  const invocations = new Map<
    string,
    { args: string[]; cwd: string; stdinLines: string[] }
  >();
  for (const entry of entries) {
    if (entry.type === "start") {
      invocations.set(entry.id, {
        args: entry.args,
        cwd: entry.cwd,
        stdinLines: [],
      });
      continue;
    }
    if (entry.type !== "stdin") continue;
    const invocation = invocations.get(entry.id);
    if (invocation !== undefined) invocation.stdinLines.push(entry.line);
  }
  return Array.from(invocations.values());
}

export function installCodexReplayerAt(
  directory: string,
  caseName: string,
  syntheticFaultInjection = false,
): InstalledCodexReplayer {
  const fixtureDirectory = join(fixtureRoot, caseName);
  const fixtureRecording = JSON.parse(
    readFileSync(join(fixtureDirectory, "recording.json"), "utf8"),
  );
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, "invocations.log");
  writeFileSync(logPath, "");
  const installedFixtureDirectory = join(directory, "fixture");
  mkdirSync(installedFixtureDirectory);
  const qualificationCase = JSON.parse(
    readFileSync(join(qualificationFixtureDirectory, "case.json"), "utf8"),
  );
  const selectedCase = JSON.parse(
    readFileSync(join(fixtureDirectory, "case.json"), "utf8"),
  );
  const strictReplay =
    !syntheticFaultInjection && selectedCase.replay === "strict";
  writeFileSync(
    join(installedFixtureDirectory, "case.json"),
    JSON.stringify({
      ...qualificationCase,
      ...selectedCase,
      // Protocol-private tests deliberately inject deterministic faults over the
      // recorded qualification exchange. Only that explicit synthetic mode may
      // use the configurable response generator; real cases stay strict.
      replay: strictReplay ? "strict" : "synthetic-fault-injection",
      responses: {
        ...qualificationCase.responses,
        ...selectedCase.responses,
      },
    }),
  );
  const workspacePatch = join(fixtureDirectory, "workspace.patch");
  if (existsSync(workspacePatch)) {
    copyFileSync(
      workspacePatch,
      join(installedFixtureDirectory, "workspace.patch"),
    );
  }
  const windows = process.platform === "win32";
  const executablePath = join(directory, windows ? "codex.cmd" : "codex");
  const identityPath = join(directory, windows ? "codex.mjs" : "codex");
  const windowsShimPath = join(directory, "codex.cmd");
  copyFileSync(source, identityPath);
  if (windows) {
    writeFileSync(executablePath, npmBunShim("codex.mjs"));
  } else {
    chmodSync(executablePath, 0o755);
    copyFileSync(source, join(directory, "codex.mjs"));
    writeFileSync(windowsShimPath, npmBunShim("codex.mjs"));
  }
  copyFileSync(replayPathSource, join(directory, "codex-replay-path.ts"));

  let executableVersion = fixtureRecording.executableVersion;
  let versionExitCode: number | undefined;
  // Most cases only read the 689 KB schema. Share those bytes and copy lazily
  // only for drift cases, avoiding per-case Windows filesystem/AV contention.
  let schemaDirectory = sharedSchemaDirectory;
  let schemaCopied = false;
  const writeRecording = (): void => {
    writeFileSync(
      join(directory, "recording.json"),
      JSON.stringify({
        harness: "codex",
        executableVersion,
        protocolVersion: fixtureRecording.protocolVersion,
        recordedAt: fixtureRecording.recordedAt,
        redactions: fixtureRecording.redactions,
        refreshCommand: fixtureRecording.refreshCommand,
        fixtureDirectory: installedFixtureDirectory,
        schemaDirectory,
        schemaFile: SCHEMA_FILE,
        log: logPath,
        versionExitCode,
      }),
    );
  };
  const mutableSchemaPath = (): string => {
    const installedSchemaPath = join(installedFixtureDirectory, SCHEMA_FILE);
    if (!schemaCopied) {
      copyFileSync(
        join(sharedSchemaDirectory, SCHEMA_FILE),
        installedSchemaPath,
      );
      schemaDirectory = installedFixtureDirectory;
      schemaCopied = true;
      writeRecording();
    }
    return installedSchemaPath;
  };
  writeRecording();

  return {
    executablePath,
    identityPath,
    windowsShimPath,
    path: `${directory}${delimiter}${process.env.PATH ?? ""}`,
    invocations: () => readInvocations(logPath),
    drift(version) {
      executableVersion = version;
      appendFileSync(identityPath, `\n// drift ${version} ${Date.now()}\n`);
      writeRecording();
    },
    driftBytesWithoutMetadataChange() {
      const stats = statSync(identityPath);
      const sourceText = readFileSync(identityPath, "utf8");
      const changed = sourceText.replace(
        "method not found",
        "method not founD",
      );
      if (changed === sourceText) {
        throw new Error("Codex replayer identity marker was not found");
      }
      writeFileSync(identityPath, changed);
      utimesSync(identityPath, stats.atime, stats.mtime);
    },
    changeVersionOnly(version) {
      executableVersion = version;
      writeRecording();
    },
    removeSchemaMethod(method) {
      const schemaPath = mutableSchemaPath();
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      for (const definition of [
        schema.definitions.ClientRequest,
        schema.definitions.ClientNotification,
        schema.definitions.ServerNotification,
        schema.definitions.ServerRequest,
      ]) {
        definition.oneOf = definition.oneOf.filter(
          (variant: { properties: { method?: { enum: string[] } } }) =>
            !variant.properties.method?.enum.includes(method),
        );
      }
      writeFileSync(schemaPath, JSON.stringify(schema));
    },
    changeTurnStatusShape() {
      const schemaPath = mutableSchemaPath();
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      schema.definitions.v2.Turn.properties.status = { type: "number" };
      writeFileSync(schemaPath, JSON.stringify(schema));
    },
    changeApprovalSchemaShape(field) {
      const schemaPath = mutableSchemaPath();
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      if (field === "file-items") {
        const fileChange = schema.definitions.v2.ThreadItem.oneOf.find(
          (variant: { properties: { type: { enum: string[] } } }) =>
            variant.properties.type.enum.includes("fileChange"),
        );
        fileChange.properties.changes.items = { type: "string" };
      } else if (field === "command-kind-values") {
        schema.definitions.CommandExecutionApprovalKind.enum = ["writeStdin"];
      } else if (field === "request-id-types") {
        schema.definitions.v2.RequestId.anyOf = [{ type: "boolean" }];
      } else if (field === "server-request-id") {
        const commandApproval = schema.definitions.ServerRequest.oneOf.find(
          (variant: { properties: { method: { enum: string[] } } }) =>
            variant.properties.method.enum.includes(
              "item/commandExecution/requestApproval",
            ),
        );
        commandApproval.properties.id = { type: "boolean" };
      } else if (field === "command") {
        schema.definitions.CommandExecutionRequestApprovalParams.properties.command =
          { type: "number" };
      } else if (field === "command-kind") {
        schema.definitions.CommandExecutionRequestApprovalParams.properties.kind =
          { type: "string" };
      } else if (field === "resolved-id") {
        schema.definitions.v2.ServerRequestResolvedNotification.properties.requestId =
          { type: "number" };
      } else if (field === "resolved-thread") {
        schema.definitions.v2.ServerRequestResolvedNotification.properties.threadId =
          { type: "number" };
      } else if (field === "path") {
        schema.definitions.v2.FileUpdateChange.properties.path = {
          type: "number",
        };
      } else if (field === "kind") {
        schema.definitions.v2.FileUpdateChange.properties.kind = {
          type: "string",
        };
      } else {
        const update = schema.definitions.v2.PatchChangeKind.oneOf.find(
          (variant: { properties: { type: { enum: string[] } } }) =>
            variant.properties.type.enum.includes("update"),
        );
        update.properties.move_path = { type: "number" };
      }
      writeFileSync(schemaPath, JSON.stringify(schema));
    },
    corruptSchema() {
      writeFileSync(mutableSchemaPath(), "{not json");
    },
    failVersion(status) {
      versionExitCode = status;
      writeRecording();
    },
    failCleanup(status) {
      const casePath = join(installedFixtureDirectory, "case.json");
      const protocolCase = JSON.parse(readFileSync(casePath, "utf8"));
      protocolCase.exitCode = status;
      writeFileSync(casePath, JSON.stringify(protocolCase));
    },
    removeResponseField(method, field) {
      const casePath = join(installedFixtureDirectory, "case.json");
      const protocolCase = JSON.parse(readFileSync(casePath, "utf8"));
      const response = protocolCase.responses[method];
      if (typeof response.line === "string") {
        const message = JSON.parse(response.line);
        delete message.result[field];
        response.line = `${JSON.stringify(message)}\n`;
        synchronizeTraffic(protocolCase, response);
      } else {
        delete response[field];
      }
      writeFileSync(casePath, JSON.stringify(protocolCase));
    },
    requireLogin() {
      const casePath = join(installedFixtureDirectory, "case.json");
      const protocolCase = JSON.parse(readFileSync(casePath, "utf8"));
      const response = protocolCase.responses["account/read"];
      if (typeof response.line === "string") {
        const message = JSON.parse(response.line);
        message.result = { account: null, requiresOpenaiAuth: true };
        response.line = `${JSON.stringify(message)}\n`;
        synchronizeTraffic(protocolCase, response);
      } else {
        protocolCase.responses["account/read"] = {
          account: null,
          requiresOpenaiAuth: true,
        };
      }
      writeFileSync(casePath, JSON.stringify(protocolCase));
    },
    failTurn(message) {
      const casePath = join(installedFixtureDirectory, "case.json");
      const protocolCase = JSON.parse(readFileSync(casePath, "utf8"));
      protocolCase.turn = { status: "failed", message };
      writeFileSync(casePath, JSON.stringify(protocolCase));
    },
    configureTurn(options) {
      const casePath = join(installedFixtureDirectory, "case.json");
      const protocolCase = JSON.parse(readFileSync(casePath, "utf8"));
      protocolCase.turn = { ...protocolCase.turn, ...options };
      writeFileSync(casePath, JSON.stringify(protocolCase));
    },
    configureRecovery(options) {
      const casePath = join(installedFixtureDirectory, "case.json");
      const protocolCase = JSON.parse(readFileSync(casePath, "utf8"));
      protocolCase.recovery = options;
      writeFileSync(casePath, JSON.stringify(protocolCase));
    },
  };
}

function synchronizeTraffic(
  protocolCase: {
    traffic?: { direction: string; line: string }[];
  },
  response: { line: string },
): void {
  if (protocolCase.traffic === undefined) return;
  const responseMessage = JSON.parse(response.line);
  const trafficEntry = protocolCase.traffic.find((entry) => {
    if (entry.direction !== "stdout") return false;
    return JSON.parse(entry.line).id === responseMessage.id;
  });
  if (trafficEntry === undefined) {
    throw new Error("Recorded Codex response has no traffic entry");
  }
  trafficEntry.line = response.line;
}
