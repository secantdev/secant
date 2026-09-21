import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";

import { runProbe } from "./probe.mjs";

function needs(axis, pressure) {
  return axis === pressure || axis === "combined";
}

async function waitUntilReady(paths, deadlineMs = 15_000) {
  const deadline = performance.now() + deadlineMs;
  while (!paths.every((path) => existsSync(path))) {
    if (performance.now() > deadline) {
      throw new Error(`readiness barrier timed out: ${paths.join(", ")}`);
    }
    await yieldTurn();
  }
}

async function startPressure(axis, lane) {
  const bunPath = process.env.ISSUE_177_BUN;
  const childPath = process.env.ISSUE_177_CHILD;
  if (bunPath === undefined || childPath === undefined) {
    throw new Error("ISSUE_177_BUN and ISSUE_177_CHILD are required");
  }

  const root = join(tmpdir(), `issue-177-${process.pid}-${lane}`);
  mkdirSync(root, { recursive: true });
  const stopPath = join(root, "stop");
  const stressorPath = new URL("./stressor.mjs", import.meta.url).pathname;
  const children = [];
  const readyPaths = [];
  const descriptors = [];

  if (needs(axis, "cpu")) {
    const count = Math.max(1, availableParallelism());
    for (let index = 0; index < count; index += 1) {
      const readyPath = join(root, `cpu-${index}.ready`);
      readyPaths.push(readyPath);
      children.push(
        spawn(bunPath, [stressorPath, "cpu", readyPath, stopPath], {
          stdio: "ignore",
        }),
      );
    }
  }

  if (needs(axis, "churn")) {
    for (let index = 0; index < 2; index += 1) {
      const readyPath = join(root, `churn-${index}.ready`);
      readyPaths.push(readyPath);
      children.push(
        spawn(
          bunPath,
          [stressorPath, "churn", readyPath, stopPath, bunPath, childPath],
          { stdio: "ignore" },
        ),
      );
    }
  }

  if (needs(axis, "fd")) {
    for (let index = 0; index < 512; index += 1) {
      try {
        descriptors.push(openSync("/dev/null", "r"));
      } catch {
        break;
      }
    }
  }

  await waitUntilReady(readyPaths);
  return {
    descriptorCount: descriptors.length,
    stressorCount: children.length,
    async stop() {
      writeFileSync(stopPath, "stop\n");
      for (const descriptor of descriptors) closeSync(descriptor);
      await waitUntilReady(readyPaths.map((path) => `${path}.stopped`));
      for (const child of children) child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function runLane(lane) {
  const axis = process.env.ISSUE_177_AXIS ?? "baseline";
  const iterations = Number.parseInt(
    process.env.ISSUE_177_ITERATIONS ?? "5",
    10,
  );
  const pressure = await startPressure(axis, lane);
  const observations = [];
  try {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      observations.push(await runProbe({ axis, lane, iteration }));
    }
  } finally {
    await pressure.stop();
  }
  const summary = {
    kind: "lane-summary",
    axis,
    lane,
    observations: observations.length,
    failures: observations.filter(({ success }) => !success).length,
    descriptorCount: pressure.descriptorCount,
    stressorCount: pressure.stressorCount,
  };
  appendFileSync(process.env.ISSUE_177_RESULT, `${JSON.stringify(summary)}\n`);
  return summary;
}
