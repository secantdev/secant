import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

async function findTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return findTestFiles(path);
      }

      return entry.isFile() && /\.test\.tsx?$/.test(entry.name) ? [path] : [];
    }),
  );

  return nestedFiles.flat().sort();
}

const testFiles = await findTestFiles("tests");

if (testFiles.length === 0) {
  throw new Error("No recursively discovered test files were found.");
}

const child = spawn(
  process.execPath,
  [
    // OpenTUI's native render library loads via node:ffi (renderer tests), and
    // `browser` resolves solid-js to its reactive build so it shares one
    // instance with @opentui/solid. The Solid loader compiles `.ts` by stripping
    // types and `.tsx` with Solid's universal transform.
    "--experimental-ffi",
    "--conditions=browser",
    "--import",
    "./scripts/solid-test-register.mjs",
    "--test",
    ...process.argv.slice(2),
    ...testFiles,
  ],
  { stdio: "inherit" },
);

await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      reject(new Error(`Test runner exited from signal ${signal}.`));
      return;
    }

    process.exitCode = code ?? 1;
    resolve();
  });
});
