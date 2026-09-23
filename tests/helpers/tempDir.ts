import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { removeTempDir } from "./standalone.js";

// Safe to import from a standalone program: the only `node:test` dependency is the
// `after` cleanup hook below, registered inside a try/catch, so a runner without
// the test runner simply skips it. The transient-lock retry that cleanup relies on
// lives in the framework-free `removeTempDir` (tests/helpers/standalone.ts).

const tempDirectories = new Set<string>();

export function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.add(directory);
  return directory;
}

// The canonical test command isolates every file, so this registry and its cleanup
// hook are file-owned. Keep that isolation: shared-global execution can delete
// another file's live directory.
export async function cleanupTempDirsForTest(): Promise<void> {
  const directories = Array.from(tempDirectories).reverse();
  tempDirectories.clear();

  await Promise.all(directories.map(removeTempDir));
}

// Registered only under the test runner. The standalone runtime-conformance runner
// (an ordinary Bun process) imports this helper transitively through the replayer
// installers; there `after` throws, and its temp dirs are reclaimed by the OS
// exactly as that runner's own `mkdtempSync` dirs already are.
try {
  after(async () => {
    await cleanupTempDirsForTest();
  });
} catch {
  // Not under the test runner: skip the file-owned cleanup hook.
}
