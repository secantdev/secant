import assert from "node:assert/strict";
import test from "node:test";
import type {
  OwnedProcessClose,
  OwnedProcessOptions,
  ProcessInterruption,
  SpawnOptions,
} from "../../src/process/process.js";
import {
  registerProcessConformanceCases,
  type ProcessConformanceScenarios,
} from "./conformance.js";
import {
  createFakeProcess,
  type FakeOwnedProcessEmission,
} from "./fake-adapter.js";

const encoder = new TextEncoder();
const executable = "/fake/bin/runtime";
const missing = "missing-process-parity-executable";
const basicOwnedOptions: OwnedProcessOptions = {
  executable,
  args: [],
  cwd: "/fake/workspace",
  env: {},
  launchTimeoutMs: 1_000,
};
const basicCommandOptions: SpawnOptions = {
  executable,
  args: [],
  cwd: undefined,
  env: {},
  timeoutMs: 1_000,
  maxCaptureBytes: 1_024,
  truncationMarker: "[truncated]",
};

function terminal(close: OwnedProcessClose): FakeOwnedProcessEmission {
  return { kind: "terminal", trigger: "automatic", close };
}

function interruptTerminal(
  interruption: ProcessInterruption,
  gracefulMs: number,
): FakeOwnedProcessEmission {
  return {
    kind: "terminal",
    trigger: "interrupt",
    interruption,
    expectedGracefulMs: gracefulMs,
  };
}

const scenarios: ProcessConformanceScenarios = {
  label: "fake",
  resolution: () => ({
    process: createFakeProcess({
      resolutions: [
        {
          name: executable,
          result: { kind: "found", executable, prefixArgs: [] },
        },
        { name: missing, result: { kind: "not-found" } },
      ],
    }),
    foundName: executable,
    foundExecutable: executable,
    missingName: missing,
  }),
  commandExit: () => ({
    process: createFakeProcess({
      commands: [
        {
          trigger: "immediate",
          result: {
            kind: "exited",
            status: 17,
            text: encoder.encode("outerr"),
          },
        },
      ],
    }),
    options: basicCommandOptions,
    status: 17,
    text: "outerr",
  }),
  commandCancellation: () => {
    const controller = new AbortController();
    return {
      process: createFakeProcess({
        commands: [{ trigger: "cancellation", result: { kind: "cancelled" } }],
      }),
      options: { ...basicCommandOptions, cancelSignal: controller.signal },
      cancel: () => controller.abort(),
    };
  },
  ownedExit: () => ({
    process: createFakeProcess({
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            { kind: "stdout", bytes: encoder.encode("out-") },
            { kind: "stderr", bytes: encoder.encode("err-") },
            { kind: "stdout", bytes: encoder.encode("one") },
            { kind: "stderr", bytes: encoder.encode("two") },
            terminal({ kind: "exited", status: 23 }),
          ],
        },
      ],
    }),
    options: basicOwnedOptions,
    stdout: "out-one",
    stderr: "err-two",
    status: 23,
  }),
  ownedSignal: () => ({
    process: createFakeProcess({
      ownedProcesses: [
        {
          kind: "launched",
          emissions: [
            terminal(
              process.platform === "win32"
                ? { kind: "exited", status: 1 }
                : { kind: "signal", signal: "SIGTERM" },
            ),
          ],
        },
      ],
    }),
    options: basicOwnedOptions,
    terminalKind: process.platform === "win32" ? "exited" : "signal",
  }),
  gracefulInterruption: () => {
    const gracefulMs = 2_000;
    const interruption: ProcessInterruption = {
      close: { kind: "exited", status: 0 },
      escalated: process.platform === "win32",
    };
    return {
      process: createFakeProcess({
        ownedProcesses: [
          {
            kind: "launched",
            emissions: [
              { kind: "stdout", bytes: encoder.encode("ready\n") },
              interruptTerminal(interruption, gracefulMs),
            ],
          },
        ],
      }),
      options: basicOwnedOptions,
      ready: "ready",
      gracefulMs,
      escalated: interruption.escalated,
    };
  },
  forcedBoundInterruption: () => {
    const gracefulMs = 2_000;
    const interruption: ProcessInterruption = {
      close: { kind: "signal", signal: "SIGKILL" },
      escalated: true,
    };
    return {
      process: createFakeProcess({
        ownedProcesses: [
          {
            kind: "launched",
            emissions: [
              { kind: "stdout", bytes: encoder.encode("ready\n") },
              interruptTerminal(interruption, gracefulMs),
            ],
          },
        ],
      }),
      options: basicOwnedOptions,
      ready: "ready",
      gracefulMs,
      escalated: true,
    };
  },
  escalatingInterruption: () => {
    const gracefulMs = 50;
    const interruption: ProcessInterruption = {
      close: { kind: "signal", signal: "SIGKILL" },
      escalated: true,
    };
    return {
      process: createFakeProcess({
        ownedProcesses: [
          {
            kind: "launched",
            emissions: [
              { kind: "stdout", bytes: encoder.encode("ready\n") },
              interruptTerminal(interruption, gracefulMs),
            ],
          },
        ],
      }),
      options: basicOwnedOptions,
      ready: "ready",
      gracefulMs,
      escalated: true,
    };
  },
  treeCleanup: () => ({
    process: createFakeProcess({
      commands: [{ trigger: "immediate", result: { kind: "timeout" } }],
    }),
    options: basicCommandOptions,
  }),
  failures: () => ({
    process: createFakeProcess({
      resolutions: [{ name: missing, result: { kind: "not-found" } }],
      commands: [{ trigger: "immediate", result: { kind: "spawn-error" } }],
      ownedProcesses: [
        {
          kind: "launch-failure",
          failure: {
            ok: false,
            failure: { kind: "spawn-error", cause: new Error("not found") },
          },
        },
      ],
    }),
    missingName: missing,
    command: basicCommandOptions,
    owned: basicOwnedOptions,
  }),
};

registerProcessConformanceCases(scenarios, (name, body) => test(name, body));

test("fake process refuses output after a terminal result", () => {
  const fake = createFakeProcess({
    ownedProcesses: [
      {
        kind: "launched",
        emissions: [
          terminal({ kind: "exited", status: 0 }),
          { kind: "stdout", bytes: encoder.encode("late") },
        ],
      },
    ],
  });
  assert.throws(
    () => fake.spawnOwnedProcess(basicOwnedOptions),
    /emitted stdout after its terminal result/,
  );
});
