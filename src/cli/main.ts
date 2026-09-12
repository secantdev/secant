import { fileURLToPath } from "node:url";
import { runHeadlessCli, type HeadlessIO } from "../headless/headless.js";

// The CLI host owns the runtime entry: it launches the shell for a bare
// `secant` and otherwise hands argv to the one `commander` command tree in the
// headless client, which generates --help/--version. The version is embedded at
// build time by the Bun standalone compile (see scripts/build.ts `define`);
// there is no runtime manifest to read and no Node engine gate — a compiled
// binary carries its own runtime.

// Build-time constant substituted by the Bun compile. It is a free identifier
// under `bun src/cli/main.ts` (dev) and the Node test runner, where `typeof`
// reads "undefined" and the dev sentinel below stands in.
declare const __SECANT_VERSION__: string;
const version =
  typeof __SECANT_VERSION__ === "string" ? __SECANT_VERSION__ : "0.0.0-dev";

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 0) {
    // No subcommand launches the interactive shell. Loaded lazily so Solid and
    // OpenTUI's native library are never reached on the headless paths.
    const { launchTui } = await import("../composition/main.js");
    process.exitCode = await launchTui();
    return;
  }
  const io: HeadlessIO = {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    cwd: () => process.cwd(),
  };
  // The executor wires the composition root only when a command action runs, so
  // --help/--version and unknown-command errors never reach the Catalog's SQLite
  // driver (the lazy import stays behind this callback).
  process.exitCode = await runHeadlessCli(argv, io, version, async (run) => {
    const { withClients } = await import("../composition/main.js");
    return withClients(run);
  });
}

// The entry check for both runtimes. `import.meta.main` is unusable here — it is
// false inside a Bun single-file executable on Windows (a Bun quirk verified in
// #62) — so key off `Bun.main`, the entry path Bun exposes under the compiled
// binary and `bun src/cli/main.ts` alike. Normalise separators because `Bun.main`
// uses "/" while `fileURLToPath` yields the platform's. The Node test runner
// imports this module (no `Bun` global, and not the entry), so main never runs
// under test. This is the one target-source site allowed to touch a Bun API
// (ADR 0030 runtime-neutrality allowlist).
function isMainEntry(): boolean {
  const bunMain = (globalThis as { Bun?: { main?: string } }).Bun?.main;
  if (bunMain === undefined) return false;
  const normalise = (path: string): string => path.replace(/\\/g, "/");
  return normalise(bunMain) === normalise(fileURLToPath(import.meta.url));
}

if (isMainEntry()) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
