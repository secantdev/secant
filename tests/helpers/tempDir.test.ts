import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";

import { cleanupTempDirsForTest, makeTempDir } from "./tempDir.js";

async function listTestSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return listTestSourceFiles(path);
      }

      if (entry.isFile() && path.endsWith(".ts")) {
        return [path];
      }

      return [];
    }),
  );

  return nestedFiles.flat();
}

test("makeTempDir creates temp directories under the OS temp directory", () => {
  const directory = makeTempDir("secant-temp-helper-");

  assert.equal(dirname(directory), tmpdir());
  assert.equal(existsSync(directory), true);
});

test("registered temp directories are removed when cleanup runs", async () => {
  const directory = makeTempDir("secant-temp-helper-cleanup-");

  await cleanupTempDirsForTest();

  assert.equal(existsSync(directory), false);
});

test("test temp directories are allocated through the shared helper", async () => {
  const testsDirectory = join(process.cwd(), "tests");
  const sourceFiles = await listTestSourceFiles(testsDirectory);
  const inlineTempDirPattern =
    /mkdtemp(?:Sync)?\s*\(\s*(?:path\.)?join\s*\(\s*(?:os\.)?tmpdir\s*\(/;
  const offenders: string[] = [];

  // The shared helper registers a `node:test` `after` cleanup hook, so it can
  // only be used from files the `bun test` runner drives. The helper itself is
  // exempt, and so are standalone scripts run under `bun`, not `bun test`, which
  // cannot import the helper and remove their own temp directories in a `finally`:
  // the real-terminal lifecycle suite (#56) and the opt-in Claude Code recorder (#115).
  // The declaration-surface check (S2) is a pure architecture check that emits
  // declarations to a temp dir and removes it in a `finally`, so it is exempt too.
  const exempt = new Set([
    "helpers/tempDir.ts",
    "terminal/lifecycle.ts",
    "harness/record.ts",
    "architecture/check-vendor-provenance.ts",
  ]);

  for (const sourceFile of sourceFiles) {
    const relativeToTests = relative(testsDirectory, sourceFile)
      .split(sep)
      .join("/");
    if (exempt.has(relativeToTests)) {
      continue;
    }

    const source = await readFile(sourceFile, "utf8");

    if (inlineTempDirPattern.test(source)) {
      offenders.push(relative(process.cwd(), sourceFile).split(sep).join("/"));
    }
  }

  assert.deepEqual(offenders, []);
});
