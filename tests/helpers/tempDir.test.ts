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

  for (const sourceFile of sourceFiles) {
    const relativeToTests = relative(testsDirectory, sourceFile)
      .split(sep)
      .join("/");
    if (relativeToTests === "helpers/tempDir.ts") {
      continue;
    }

    const source = await readFile(sourceFile, "utf8");

    if (inlineTempDirPattern.test(source)) {
      offenders.push(relative(process.cwd(), sourceFile).split(sep).join("/"));
    }
  }

  assert.deepEqual(offenders, []);
});
