#!/usr/bin/env bun
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createProcessAdapter,
  type OwnedProcessOptions,
  type SpawnOptions,
} from "../../src/process/process.js";
import {
  registerProcessConformanceCases,
  type ProcessConformanceBody,
  type ProcessConformanceScenarios,
} from "./conformance.js";

const executable = process.execPath;
const missing = join(tmpdir(), `secant-process-parity-missing-${process.pid}`);
const SCENARIO_TIMEOUT_MS = 20_000;

function commandOptions(
  source: string,
  overrides: Partial<SpawnOptions> = {},
): SpawnOptions {
  return {
    executable,
    args: ["-e", source],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5_000,
    maxCaptureBytes: 1_024 * 1_024,
    truncationMarker: "\n[truncated]\n",
    ...overrides,
  };
}

function ownedOptions(source: string): OwnedProcessOptions {
  return {
    executable,
    args: ["-e", source],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5_000,
  };
}

function delayedForcedCloseSource(delayAfterSignalMs: number): string {
  const holder =
    "process.on('message',()=>setTimeout(()=>process.exit(0)," +
    `${delayAfterSignalMs}));process.send?.('ready');setInterval(()=>{},1000)`;
  return (
    "const{spawn}=require('node:child_process');" +
    `const holder=spawn(process.execPath,['-e',${JSON.stringify(holder)}],` +
    "{detached:true,stdio:['ignore','inherit','inherit','ipc']});" +
    "holder.on('message',()=>process.stdout.write('ready\\n'));" +
    "process.on('SIGTERM',()=>holder.send('release'));" +
    "setInterval(()=>{},1000)"
  );
}

const scenarios: ProcessConformanceScenarios = {
  label: "real",
  resolution: () => ({
    process: createProcessAdapter(),
    foundName: executable,
    foundExecutable: executable,
    missingName: missing,
  }),
  commandExit: () => ({
    process: createProcessAdapter(),
    options: commandOptions(
      "process.stdout.write('out');process.stderr.write('err');process.exit(17)",
    ),
    status: 17,
    text: "outerr",
  }),
  commandCancellation: () => {
    const controller = new AbortController();
    return {
      process: createProcessAdapter(),
      options: commandOptions("setInterval(()=>{},1000)", {
        cancelSignal: controller.signal,
      }),
      cancel: () => controller.abort(),
    };
  },
  ownedExit: () => ({
    process: createProcessAdapter(),
    options: ownedOptions(
      "process.stdout.write('out-');process.stdout.write('one');" +
        "process.stderr.write('err-');process.stderr.write('two');process.exit(23)",
    ),
    stdout: "out-one",
    stderr: "err-two",
    status: 23,
  }),
  ownedSignal: () => ({
    process: createProcessAdapter(),
    options: ownedOptions("process.kill(process.pid,'SIGTERM')"),
    terminalKind: process.platform === "win32" ? "exited" : "signal",
  }),
  gracefulInterruption: () => {
    const gracefulMs = 2_000;
    return {
      process: createProcessAdapter(),
      options: ownedOptions(
        // Exit after half the supplied bound. A shutdown that split gracefulMs
        // between stages would force-kill this process instead of observing its
        // graceful exit, turning the escalation assertion red.
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),1500));" +
          "process.stdout.write('ready\\n');setInterval(()=>{},1000)",
      ),
      ready: "ready",
      gracefulMs,
      escalated: process.platform === "win32",
    };
  },
  forcedBoundInterruption: () => {
    const gracefulMs = 2_000;
    const source =
      process.platform === "win32"
        ? "process.on('SIGTERM',()=>{});" +
          "process.stdout.write('ready\\n');setInterval(()=>{},1000)"
        : delayedForcedCloseSource(gracefulMs + 1_500);
    return {
      process: createProcessAdapter(),
      options: ownedOptions(source),
      ready: "ready",
      gracefulMs,
      escalated: true,
    };
  },
  escalatingInterruption: () => ({
    process: createProcessAdapter(),
    options: ownedOptions(
      "process.on('SIGTERM',()=>{});" +
        "process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ),
    ready: "ready",
    gracefulMs: 100,
    escalated: true,
  }),
  treeCleanup: () => ({
    process: createProcessAdapter(),
    options: commandOptions(
      "const{spawn}=require('node:child_process');" +
        "spawn(process.execPath,['-e','setInterval(()=>{},1000)']," +
        "{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)",
      { timeoutMs: 200 },
    ),
  }),
  failures: () => ({
    process: createProcessAdapter(),
    missingName: missing,
    command: {
      ...commandOptions(""),
      executable: missing,
      args: [],
    },
    owned: {
      ...ownedOptions(""),
      executable: missing,
      args: [],
    },
  }),
};

interface RegisteredCase {
  readonly name: string;
  readonly body: ProcessConformanceBody;
}

const cases: RegisteredCase[] = [];
registerProcessConformanceCases(scenarios, (name, body) => {
  cases.push({ name, body });
});

async function main(): Promise<void> {
  for (const scenario of cases) {
    try {
      await withinScenarioBound(scenario.body(), scenario.name);
      console.log(`  ok  ${scenario.name}`);
    } catch (error) {
      console.error(`FAILED ${scenario.name}`);
      throw error;
    }
  }
  console.log("Process runtime conformance passed.");
}

function withinScenarioBound(
  result: void | Promise<void>,
  name: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${name} did not settle within 20 seconds`)),
      SCENARIO_TIMEOUT_MS,
    );
  });
  return Promise.race([Promise.resolve(result), elapsed]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
