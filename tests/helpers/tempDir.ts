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

// Under `bun test` every test file shares one process, so this cleanup can hit a
// temp dir whose owning file has already closed its handles but whose files
// Windows still briefly reports as locked (a just-closed SQLite database is the
// usual culprit). Retry the removal until the lock clears.
async function removeTempDir(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient =
        code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!transient || attempt >= 20) throw error;
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
