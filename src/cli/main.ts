import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The CLI hosts command dispatch and answers --help/--version directly. It fails
// fast when the running Node is below the engines floor, naming the required
// range, before the composition root opens the Catalog database.

interface Manifest {
  readonly version: string;
  readonly engineRange: string;
}

function readManifest(): Manifest {
  // The nearest package.json above this module is the package's own manifest
  // (dist/cli.js sits directly under the package root); it is authoritative.
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      const manifest: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      const record =
        typeof manifest === "object" && manifest !== null
          ? (manifest as Record<string, unknown>)
          : {};
      const version = record.version;
      const engines = record.engines as { node?: unknown } | undefined;
      const engineRange = engines?.node;
      if (typeof version !== "string") {
        throw new Error(`${candidate} has no string version to report.`);
      }
      if (typeof engineRange !== "string" || !/\d/.test(engineRange)) {
        // The package's own manifest is authoritative; a range with no numeric
        // floor is a build defect, so fail loudly rather than pass every Node.
        throw new Error(
          `${candidate} has no numeric engines.node floor to enforce.`,
        );
      }
      return { version, engineRange };
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Could not locate package.json to read the manifest.");
    }
    directory = parent;
  }
}

// ponytail: major-version floor compare; the engines floor is a `.0.0` major.
// Tighten to full semver only if a non-zero minor floor is ever set.
export function withinEngineFloor(
  engineRange: string,
  nodeVersion: string,
): boolean {
  const floor = engineRange.match(/\d+/);
  const current = nodeVersion.match(/\d+/);
  if (floor === null || current === null) return true;
  return Number(current[0]) >= Number(floor[0]);
}

const helpText = `Usage: secant <command> [options]

Commands:
  workspace [--json]              show the Workspace path and approval state
  workspace approve [path]        approve a directory as the Workspace

Options:
  -V, --version  output the version number
  -h, --help     display help for command
`;

async function main(argv: readonly string[]): Promise<void> {
  const manifest = readManifest();
  if (!withinEngineFloor(manifest.engineRange, process.version)) {
    process.stderr.write(
      `Secant requires Node ${manifest.engineRange}, but this is ${process.version}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(helpText);
    return;
  }
  if (argv.includes("-V") || argv.includes("--version")) {
    process.stdout.write(`${manifest.version}\n`);
    return;
  }
  if (argv[0] === "workspace") {
    // Loaded lazily so the Catalog's node:sqlite is never reached until the
    // engine gate above has passed.
    const { run } = await import("../composition/main.js");
    process.exitCode = run(argv);
    return;
  }
  // Unknown command: keep printing help until the shell slice replaces it.
  process.stdout.write(helpText);
}

function isMainEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // realpath both sides so an npm bin symlink still matches the real cli.js,
    // while importing this module (e.g. from a test) never runs main().
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
