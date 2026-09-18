import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/tempDir.js";

const source = join(
  dirname(fileURLToPath(import.meta.url)),
  "codex-replayer.mjs",
);
const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "codex",
  "codex-qualification",
);
const fixtureRecording = JSON.parse(
  readFileSync(join(fixtureDirectory, "recording.json"), "utf8"),
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
  corruptSchema(): void;
  failVersion(status: number): void;
  failCleanup(status: number): void;
  removeResponseField(method: string, field: string): void;
  requireLogin(): void;
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

export function installCodexReplayer(): InstalledCodexReplayer {
  const directory = makeTempDir("secant-codex-replayer-");
  const logPath = join(directory, "invocations.log");
  writeFileSync(logPath, "");
  mkdirSync(directory, { recursive: true });
  const installedFixtureDirectory = join(directory, "fixture");
  mkdirSync(installedFixtureDirectory);
  copyFileSync(
    join(fixtureDirectory, "case.json"),
    join(installedFixtureDirectory, "case.json"),
  );
  copyFileSync(
    join(fixtureDirectory, "stable-schema.generated.json"),
    join(installedFixtureDirectory, "stable-schema.generated.json"),
  );

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

  let executableVersion = fixtureRecording.executableVersion;
  let versionExitCode: number | undefined;
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
        schemaFile: "stable-schema.generated.json",
        log: logPath,
        versionExitCode,
      }),
    );
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
      const schemaPath = join(
        installedFixtureDirectory,
        "stable-schema.generated.json",
      );
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
      const schemaPath = join(
        installedFixtureDirectory,
        "stable-schema.generated.json",
      );
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      schema.definitions.v2.Turn.properties.status = { type: "number" };
      writeFileSync(schemaPath, JSON.stringify(schema));
    },
    corruptSchema() {
      writeFileSync(
        join(installedFixtureDirectory, "stable-schema.generated.json"),
        "{not json",
      );
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
