import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  availableParallelism,
  cpus,
  freemem,
  loadavg,
  platform,
  release,
  totalmem,
} from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const prototypeRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(prototypeRoot, "..", "..");
const resultRoot = join(repositoryRoot, "prototype-results", "issue-177");
mkdirSync(resultRoot, { recursive: true });

const bunPath = process.execPath;
const childPath = join(prototypeRoot, "child.mjs");
const axes = ["baseline", "cpu", "churn", "fd", "combined"];
const laneCount = Number.parseInt(process.env.ISSUE_177_LANES ?? "12", 10);
const generatedRoot = join(resultRoot, "generated-tests");
mkdirSync(generatedRoot, { recursive: true });
const scenarioUrl = pathToFileURL(join(prototypeRoot, "scenario.mjs")).href;
const testFiles = Array.from({ length: laneCount }, (_, index) => {
  const path = join(generatedRoot, `lane-${index}.test.mjs`);
  writeFileSync(
    path,
    `import { test } from "node:test";\nimport { runLane } from ${JSON.stringify(scenarioUrl)};\ntest("child lifecycle lane ${index}", async () => void (await runLane("test-${index}")));\n`,
  );
  return path;
});
const topLevelPath = join(prototypeRoot, "top-level.mjs");
const sustainedTopLevelPath = join(prototypeRoot, "sustained-top-level.mjs");
const iterations = process.env.ISSUE_177_ITERATIONS ?? "5";
const sustainedIterations = process.env.ISSUE_177_SUSTAINED_ITERATIONS ?? "2";
const sustainedCycles = Number.parseInt(
  process.env.ISSUE_177_SUSTAINED_CYCLES ?? "10",
  10,
);
const sustainedTestFiles = [];
for (let cycle = 0; cycle < sustainedCycles; cycle += 1) {
  for (const [axisIndex, axis] of axes.entries()) {
    const path = join(
      generatedRoot,
      `sustained-${String(cycle).padStart(2, "0")}-${axisIndex}-${axis}.test.mjs`,
    );
    writeFileSync(
      path,
      `import { test } from "node:test";\nimport { runLane } from ${JSON.stringify(scenarioUrl)};\ntest("sustained cycle ${cycle} ${axis}", async () => void (await runLane("sustained-${cycle}-${axis}", "${axis}")));\n`,
    );
    sustainedTestFiles.push(path);
  }
}
const modes = [
  { name: "bun-test", executable: bunPath, args: ["test", ...testFiles] },
  {
    name: "bun-test-isolate",
    executable: bunPath,
    args: ["test", "--isolate", ...testFiles],
  },
  {
    name: "bun-test-parallel-1",
    executable: bunPath,
    args: ["test", "--parallel=1", ...testFiles],
  },
  { name: "bun-run", executable: bunPath, args: [topLevelPath] },
  { name: "node-run", executable: "node", args: [topLevelPath] },
];
const sustainedModes = [
  {
    name: "bun-test-sustained",
    executable: bunPath,
    args: ["test", "--timeout", "30000", ...sustainedTestFiles],
  },
  {
    name: "bun-test-isolate-sustained",
    executable: bunPath,
    args: ["test", "--isolate", "--timeout", "30000", ...sustainedTestFiles],
  },
  {
    name: "bun-test-parallel-1-sustained",
    executable: bunPath,
    args: ["test", "--parallel=1", "--timeout", "30000", ...sustainedTestFiles],
  },
  {
    name: "bun-run-sustained",
    executable: bunPath,
    args: [sustainedTopLevelPath],
  },
  {
    name: "node-run-sustained",
    executable: "node",
    args: [sustainedTopLevelPath],
  },
];

const readLinuxFile = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const resourceSnapshot = () => ({
  freeMemoryBytes: freemem(),
  loadAverage: loadavg(),
  procLoadavg: readLinuxFile("/proc/loadavg"),
  cpuPressure: readLinuxFile("/proc/pressure/cpu"),
  ioPressure: readLinuxFile("/proc/pressure/io"),
  memoryPressure: readLinuxFile("/proc/pressure/memory"),
  cgroupCpu: readLinuxFile("/sys/fs/cgroup/cpu.stat"),
  cgroupMemoryEvents: readLinuxFile("/sys/fs/cgroup/memory.events"),
  cgroupPids: readLinuxFile("/sys/fs/cgroup/pids.current"),
});

const nodeVersion = spawnSync("node", ["--version"], {
  encoding: "utf8",
}).stdout.trim();
const openFileLimit = spawnSync("/bin/sh", ["-c", "ulimit -n"], {
  encoding: "utf8",
}).stdout.trim();
const environment = {
  capturedAt: new Date().toISOString(),
  bunVersion: process.versions.bun,
  nodeVersion,
  platform: platform(),
  release: release(),
  architecture: process.arch,
  availableParallelism: availableParallelism(),
  cpuCount: cpus().length,
  cpuModels: [...new Set(cpus().map(({ model }) => model))],
  totalMemoryBytes: totalmem(),
  freeMemoryBytesAtStart: freemem(),
  loadAverageAtStart: loadavg(),
  openFileLimit,
  runner: {
    name: process.env.RUNNER_NAME,
    os: process.env.RUNNER_OS,
    architecture: process.env.RUNNER_ARCH,
    imageOs: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    region: process.env.RUNNER_REGION,
  },
  procLoadavg: readLinuxFile("/proc/loadavg"),
  procMeminfo: readLinuxFile("/proc/meminfo"),
  resourceSnapshotAtStart: resourceSnapshot(),
};
writeFileSync(
  join(resultRoot, "environment.json"),
  `${JSON.stringify(environment, null, 2)}\n`,
);

const summaries = [];
for (const axis of axes) {
  for (const mode of modes) {
    const resultPath = join(resultRoot, `${axis}--${mode.name}.jsonl`);
    writeFileSync(resultPath, "");
    const startedAt = performance.now();
    const parentStartedAt = new Date().toISOString();
    const resourcesBefore = resourceSnapshot();
    const result = spawnSync(mode.executable, mode.args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        ISSUE_177_AXIS: axis,
        ISSUE_177_BUN: bunPath,
        ISSUE_177_CHILD: childPath,
        ISSUE_177_ITERATIONS: iterations,
        ISSUE_177_LANES: String(laneCount),
        ISSUE_177_PARENT_STARTED_AT: parentStartedAt,
        ISSUE_177_RESULT: resultPath,
      },
    });
    const lines = readFileSync(resultPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const observations = lines.filter(({ kind }) => kind === "observation");
    const syncObservations = lines.filter(
      ({ kind }) => kind === "sync-observation",
    );
    const syncStarts = lines.filter(({ kind }) => kind === "sync-start");
    const failures = [...observations, ...syncObservations].filter(
      ({ success }) => !success,
    );
    const failureCounts = {};
    for (const failure of failures) {
      for (const reason of failure.failureReasons) {
        failureCounts[reason] = (failureCounts[reason] ?? 0) + 1;
      }
    }
    const summary = {
      axis,
      mode: mode.name,
      command: [mode.executable, ...mode.args],
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
      processStatus: result.status,
      processSignal: result.signal,
      processError: result.error?.message,
      observations: observations.length,
      syncObservations: syncObservations.length,
      incompleteSyncProbes: syncStarts.length - syncObservations.length,
      failures: failures.length,
      failureReasons: failureCounts,
      pressure: lines.filter(({ kind }) => kind === "lane-summary"),
      resourcesBefore,
      resourcesAfter: resourceSnapshot(),
      stdout: result.stdout,
      stderr: result.stderr,
    };
    summaries.push(summary);
    console.log(
      JSON.stringify({
        axis,
        mode: mode.name,
        observations: summary.observations,
        syncObservations: summary.syncObservations,
        failures: summary.failures,
        processStatus: summary.processStatus,
        processSignal: summary.processSignal,
        processError: summary.processError,
      }),
    );
  }
}

for (const mode of sustainedModes) {
  const axis = "sustained";
  const resultPath = join(resultRoot, `${axis}--${mode.name}.jsonl`);
  writeFileSync(resultPath, "");
  const startedAt = performance.now();
  const parentStartedAt = new Date().toISOString();
  const resourcesBefore = resourceSnapshot();
  const result = spawnSync(mode.executable, mode.args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      ISSUE_177_BUN: bunPath,
      ISSUE_177_CHILD: childPath,
      ISSUE_177_ITERATIONS: sustainedIterations,
      ISSUE_177_LANES: String(laneCount),
      ISSUE_177_PARENT_STARTED_AT: parentStartedAt,
      ISSUE_177_RESULT: resultPath,
      ISSUE_177_SUSTAINED_CYCLES: String(sustainedCycles),
    },
  });
  const lines = readFileSync(resultPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const observations = lines.filter(({ kind }) => kind === "observation");
  const syncObservations = lines.filter(
    ({ kind }) => kind === "sync-observation",
  );
  const syncStarts = lines.filter(({ kind }) => kind === "sync-start");
  const failures = [...observations, ...syncObservations].filter(
    ({ success }) => !success,
  );
  const failureCounts = {};
  for (const failure of failures) {
    for (const reason of failure.failureReasons) {
      failureCounts[reason] = (failureCounts[reason] ?? 0) + 1;
    }
  }
  const summary = {
    axis,
    mode: mode.name,
    command: [mode.executable, ...mode.args],
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
    processStatus: result.status,
    processSignal: result.signal,
    processError: result.error?.message,
    observations: observations.length,
    syncObservations: syncObservations.length,
    incompleteSyncProbes: syncStarts.length - syncObservations.length,
    failures: failures.length,
    failureReasons: failureCounts,
    pressure: lines.filter(({ kind }) => kind === "lane-summary"),
    resourcesBefore,
    resourcesAfter: resourceSnapshot(),
    stdout: result.stdout,
    stderr: result.stderr,
  };
  summaries.push(summary);
  console.log(
    JSON.stringify({
      axis,
      mode: mode.name,
      observations: summary.observations,
      syncObservations: summary.syncObservations,
      failures: summary.failures,
      processStatus: summary.processStatus,
      processSignal: summary.processSignal,
      processError: summary.processError,
    }),
  );
}

writeFileSync(
  join(resultRoot, "summary.json"),
  `${JSON.stringify({ environment, summaries }, null, 2)}\n`,
);

const emptyCells = summaries.filter(({ observations }) => observations === 0);
if (emptyCells.length > 0) {
  console.error(
    `prototype invalid: ${emptyCells.length} cells produced no observations`,
  );
  process.exitCode = 1;
}
