import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const tempDirectories = new Set<string>();

export function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.add(directory);
  return directory;
}

// The canonical test command isolates every file, so this registry and its
// cleanup hook are file-owned. Keep that isolation: shared-global execution can
// delete another file's live directory. Windows can still briefly report a
// just-closed SQLite database as locked, so retry until the lock clears. Cleanup
// remains best-effort; the OS eventually reclaims a leftover temp directory.
async function removeTempDir(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient =
        code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!transient || attempt >= 20) {
        process.stderr.write(
          `warning: could not remove temp dir ${directory}: ${String(error)}\n`,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function cleanupTempDirsForTest(): Promise<void> {
  const directories = Array.from(tempDirectories).reverse();
  tempDirectories.clear();

  await Promise.all(directories.map(removeTempDir));
}

after(async () => {
  await cleanupTempDirsForTest();
});
