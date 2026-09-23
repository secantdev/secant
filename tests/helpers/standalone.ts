import { rm } from "node:fs/promises";

// Shared helpers for the framework-free runner programs (the terminal-lifecycle
// suite and the runtime-conformance suite). These are ordinary Bun programs, not
// `node:test` suites, so they own their own scenario timeouts, process exit, and
// temp-dir cleanup. This module registers no `node:test` hook, so it is safe to
// import from a standalone program.

/** Race a promise against a timeout that rejects with `message`. Each runner bounds
 *  every scenario so a hung child fails the run instead of stalling CI. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Run a standalone program's `main` and exit non-zero on any rejection, printing
 *  the stack. A runner owns its process exit; a test-runner suite never calls this. */
export function runMain(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exit(1);
  });
}

/** Best-effort recursive removal that retries the transient Windows lock codes: a
 *  just-closed bun:sqlite catalog can briefly report EBUSY/EPERM/ENOTEMPTY (#64).
 *  Cleanup stays best-effort; the OS eventually reclaims a leftover temp dir. */
export async function removeTempDir(directory: string): Promise<void> {
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
