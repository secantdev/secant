// The CLI hosts command dispatch and answers --help/--version directly. The
// version is embedded at build time by the Bun standalone compile (see
// scripts/build.ts `define`); there is no runtime manifest to read and no Node
// engine gate — a compiled binary carries its own runtime.

// Build-time constant substituted by the Bun compile. It is a free identifier
// under `bun src/cli/main.ts` (dev) and the Node test runner, where `typeof`
// reads "undefined" and the dev sentinel below stands in.
declare const __SECANT_VERSION__: string;
const version =
  typeof __SECANT_VERSION__ === "string" ? __SECANT_VERSION__ : "0.0.0-dev";

const helpText = `Usage: secant [command] [options]

Running \`secant\` with no command opens the interactive workspace shell.

Commands:
  workspace [--json]              show the Workspace path and approval state
  workspace approve [path]        approve a directory as the Workspace
  bundle build <folder> --no-install --output <file>
                                  build an authoring folder into a .wfb file

Options:
  -V, --version  output the version number
  -h, --help     display help for command
`;

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(helpText);
    return;
  }
  if (argv.includes("-V") || argv.includes("--version")) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (argv.length === 0) {
    // No subcommand launches the interactive shell. Loaded lazily so Solid and
    // OpenTUI's native library are never reached on the headless paths.
    const { launchTui } = await import("../composition/main.js");
    process.exitCode = await launchTui();
    return;
  }
  if (argv[0] === "workspace" || argv[0] === "bundle") {
    // Loaded lazily so the Catalog's SQLite driver is never reached on the
    // --help/--version paths.
    const { run } = await import("../composition/main.js");
    process.exitCode = run(argv);
    return;
  }
  // Unknown command: print help rather than launch the shell.
  process.stdout.write(helpText);
}

// `import.meta.main` is true only when this module is the process entry — the
// compiled Bun binary, `bun src/cli/main.ts`, and a Node entry alike — and false
// when a test imports it, so main never runs under test. One check, both
// runtimes.
if (import.meta.main) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
