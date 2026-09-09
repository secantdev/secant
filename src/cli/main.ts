import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Slice-zero stub: answers --help and --version only. It is the installed-package
// smoke target, not target behavior; real command hosting arrives with the client slices.

function readVersion(): string {
  // The nearest package.json above this module is the package's own manifest
  // (dist/cli.js sits directly under the package root); it is authoritative, so
  // never walk past it, and fail loudly if it lacks a version rather than reading
  // an unrelated ancestor manifest.
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      const manifest: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      const version =
        typeof manifest === "object" && manifest !== null
          ? (manifest as { version?: unknown }).version
          : undefined;
      if (typeof version !== "string") {
        throw new Error(`${candidate} has no string version to report.`);
      }
      return version;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        "Could not locate package.json to read the Secant version.",
      );
    }
    directory = parent;
  }
}

const helpText = `Usage: secant [options]

Secant is in early development; no commands are available yet.

Options:
  -V, --version  output the version number
  -h, --help     display help for command
`;

function main(argv: readonly string[]): void {
  if (argv.includes("-V") || argv.includes("--version")) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  process.stdout.write(helpText);
}

main(process.argv.slice(2));
