import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const expectedStatus = 17;

function receiptPath(resultPath, token) {
  const root = join(dirname(resultPath), "receipts");
  mkdirSync(root, { recursive: true });
  return join(root, `${token.replaceAll(":", "-")}.json`);
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function childOsState(pid) {
  if (process.platform !== "linux") return undefined;
  return {
    status: readOptional(`/proc/${pid}/status`),
    waitChannel: readOptional(`/proc/${pid}/wchan`),
  };
}

export function runSyncProbe({ axis, lane }) {
  const bunPath = process.env.ISSUE_177_BUN;
  const childPath = process.env.ISSUE_177_CHILD;
  const resultPath = process.env.ISSUE_177_RESULT;
  if (
    bunPath === undefined ||
    childPath === undefined ||
    resultPath === undefined
  ) {
    throw new Error(
      "ISSUE_177_BUN, ISSUE_177_CHILD, and ISSUE_177_RESULT are required",
    );
  }

  const token = `${axis}:${lane}:${process.pid}:sync`;
  const receipt = receiptPath(resultPath, token);
  appendFileSync(
    resultPath,
    `${JSON.stringify({ kind: "sync-start", axis, lane, token, at: new Date().toISOString() })}\n`,
  );
  const startedAt = performance.now();
  const result = spawnSync(bunPath, [childPath], {
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      ISSUE_177_RECEIPT: receipt,
      ISSUE_177_TOKEN: token,
    },
  });
  const expectedStdout = `stdout-a:${token}\nstdout-b:${token}\n`;
  const expectedStderr = `stderr:${token}\n`;
  const failureReasons = [];
  if (result.error !== undefined) failureReasons.push("spawn-sync-error");
  if (result.status !== expectedStatus)
    failureReasons.push("exit-code-mismatch");
  if (result.stdout !== expectedStdout) failureReasons.push("stdout-mismatch");
  if (result.stderr !== expectedStderr) failureReasons.push("stderr-mismatch");
  if (!existsSync(receipt)) failureReasons.push("missing-completion-receipt");
  const observation = {
    kind: "sync-observation",
    axis,
    lane,
    token,
    parentRuntime: process.versions.bun === undefined ? "node" : "bun",
    parentPid: process.pid,
    parentStartedAt: process.env.ISSUE_177_PARENT_STARTED_AT,
    observedAt: new Date().toISOString(),
    success: failureReasons.length === 0,
    failureReasons,
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
    receipt: readOptional(receipt),
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
  };
  appendFileSync(resultPath, `${JSON.stringify(observation)}\n`);
  return observation;
}

export async function runProbe({ axis, lane, iteration }) {
  const bunPath = process.env.ISSUE_177_BUN;
  const childPath = process.env.ISSUE_177_CHILD;
  const resultPath = process.env.ISSUE_177_RESULT;
  if (
    bunPath === undefined ||
    childPath === undefined ||
    resultPath === undefined
  ) {
    throw new Error(
      "ISSUE_177_BUN, ISSUE_177_CHILD, and ISSUE_177_RESULT are required",
    );
  }

  const token = `${axis}:${lane}:${process.pid}:${iteration}`;
  const receipt = receiptPath(resultPath, token);
  const startedAt = performance.now();
  const events = [];
  let stdout = "";
  let stderr = "";
  let settled = false;

  const child = spawn(bunPath, [childPath], {
    env: {
      ...process.env,
      ISSUE_177_RECEIPT: receipt,
      ISSUE_177_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  events.push({ event: "returned", atMs: 0, exitCode: child.exitCode });

  const record = (event, details = {}) => {
    events.push({
      event,
      atMs: Number((performance.now() - startedAt).toFixed(3)),
      exitCode: child.exitCode,
      ...details,
    });
  };

  child.once("spawn", () => record("spawn"));
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    record("stdout", { bytes: Buffer.byteLength(text), text });
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    record("stderr", { bytes: Buffer.byteLength(text), text });
  });

  const outcome = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      record("timeout", {
        completionReceipt: readOptional(receipt),
        osState: childOsState(child.pid),
      });
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill("SIGKILL");
      resolve("timeout");
    }, 2_000);

    child.once("error", (error) => {
      record("error", { message: error.message });
    });
    child.once("exit", (code, signal) => record("exit", { code, signal }));
    child.once("close", (code, signal) => {
      record("close", { code, signal });
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve("close");
    });
  });

  const eventNames = events.map(({ event }) => event);
  const expectedStdout = `stdout-a:${token}\nstdout-b:${token}\n`;
  const expectedStderr = `stderr:${token}\n`;
  const failureReasons = [];
  if (outcome !== "close") failureReasons.push("missing-close");
  if (!eventNames.includes("spawn")) failureReasons.push("missing-spawn");
  if (!eventNames.includes("exit")) failureReasons.push("missing-exit");
  if (stdout !== expectedStdout) failureReasons.push("stdout-mismatch");
  if (stderr !== expectedStderr) failureReasons.push("stderr-mismatch");
  if (child.exitCode !== expectedStatus)
    failureReasons.push("exit-code-mismatch");
  if (!existsSync(receipt)) failureReasons.push("missing-completion-receipt");
  if (eventNames.indexOf("exit") > eventNames.indexOf("close")) {
    failureReasons.push("close-before-exit");
  }

  const observation = {
    kind: "observation",
    axis,
    lane,
    iteration,
    parentRuntime: process.versions.bun === undefined ? "node" : "bun",
    parentPid: process.pid,
    parentStartedAt: process.env.ISSUE_177_PARENT_STARTED_AT,
    observedAt: new Date().toISOString(),
    success: failureReasons.length === 0,
    failureReasons,
    finalExitCode: child.exitCode,
    stdout,
    stderr,
    receipt: readOptional(receipt),
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
    events,
  };
  appendFileSync(resultPath, `${JSON.stringify(observation)}\n`);
  return observation;
}
