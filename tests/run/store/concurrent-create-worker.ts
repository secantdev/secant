import { openRunGroup } from "../../../src/run/store/store.js";
import { createProcessAdapter } from "../../../src/process/process.js";

const [home, workspacePath, operationId, mode] = process.argv.slice(2);
if (!home || !workspacePath || !operationId) {
  throw new Error("expected home, Workspace path, and operation id");
}

const group = openRunGroup(home, workspacePath, {
  process: createProcessAdapter(),
});
try {
  process.stdout.write("ready\n");
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });
  if (mode === "barrier") {
    process.stdout.write("creating\n");
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => resolve());
    });
  }
  const result = group.createRun({
    operationId,
    bundleSnapshotDigest: "sha256:concurrent-writer",
    launch: { source: "concurrent-writer-test" },
    at: new Date("2026-09-15T12:00:00.000Z"),
  });
  process.stdout.write(`${result.outcome}\n`);
  if (mode === "hold") {
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => resolve());
    });
  }
} finally {
  group.close();
}
