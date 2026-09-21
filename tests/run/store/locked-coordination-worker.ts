import { openRunGroup } from "../../../src/run/store/store.js";
import { createProcessAdapter } from "../../../src/process/process.js";

const [home, workspacePath] = process.argv.slice(2);
if (!home || !workspacePath) {
  throw new Error("expected home and Workspace path");
}

try {
  const group = openRunGroup(home, workspacePath, {
    process: createProcessAdapter(),
  });
  group.close();
  throw new Error("locked coordination database unexpectedly opened");
} catch (error) {
  if (!(error instanceof AggregateError)) throw error;
  process.stdout.write(
    JSON.stringify({
      kind: "aggregate",
      errorCount: error.errors.length,
      causeIsLastError: error.cause === error.errors.at(-1),
    }),
  );
}
