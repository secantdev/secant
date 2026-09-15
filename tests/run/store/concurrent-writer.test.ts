import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openRunGroup } from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";

const WORKSPACE = "/work/concurrent-project";
const WORKER = fileURLToPath(
  new URL("./concurrent-create-worker.ts", import.meta.url),
);

type TWriter = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly completed: Promise<string>;
};

function startWriter(home: string, operationId: string): TWriter {
  const child = spawn(
    process.execPath,
    [WORKER, home, WORKSPACE, operationId],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  let markReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    rejectReady = reject;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("ready\n")) markReady?.();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const completed = new Promise<string>((resolve, reject) => {
    child.once("error", (error) => {
      rejectReady?.(error);
      reject(error);
    });
    child.once("close", (code) => {
      if (!stdout.includes("ready\n")) {
        rejectReady?.(new Error(stderr || `writer exited ${code}`));
      }
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `writer exited ${code}`));
    });
  });

  return { child, ready, completed };
}

test("two concurrent writers admit creates in one Workspace group", async (t) => {
  const home = makeTempDir("secant-concurrent-writers-");
  const first = startWriter(home, "concurrent-op-1");
  const second = startWriter(home, "concurrent-op-2");
  t.after(() => {
    first.child.kill();
    second.child.kill();
  });

  await Promise.all([first.ready, second.ready]);
  first.child.stdin.end("create\n");
  second.child.stdin.end("create\n");
  const [firstOutput, secondOutput] = await Promise.all([
    first.completed,
    second.completed,
  ]);
  assert.match(firstOutput, /ready\ncreated\n/);
  assert.match(secondOutput, /ready\ncreated\n/);

  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  assert.equal(group.listRuns().length, 2);
});
