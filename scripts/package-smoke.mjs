import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited with status ${result.status}.`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

const smokeRoot = await mkdtemp(join(tmpdir(), "secant-package-smoke-"));

try {
  run(npmCommand, ["pack", "--pack-destination", smokeRoot]);

  const archiveName = (await readdir(smokeRoot)).find((entry) =>
    entry.endsWith(".tgz"),
  );

  if (archiveName === undefined) {
    throw new Error("npm pack did not produce a package archive.");
  }

  await writeFile(
    join(smokeRoot, "package.json"),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );

  run(
    npmCommand,
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(smokeRoot, archiveName),
    ],
    { cwd: smokeRoot },
  );

  const packageDirectory = join(
    smokeRoot,
    "node_modules",
    "@secantdev",
    "secant",
  );
  const packageJson = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  const entrypoint = packageJson.bin?.secant;

  if (typeof entrypoint !== "string") {
    throw new Error("The installed package does not declare the secant bin.");
  }

  const installedEntrypoint = resolve(packageDirectory, entrypoint);
  const helpOutput = run(process.execPath, [installedEntrypoint, "--help"], {
    cwd: smokeRoot,
  });
  const versionOutput = run(
    process.execPath,
    [installedEntrypoint, "--version"],
    { cwd: smokeRoot },
  );

  if (!helpOutput.includes("Usage: secant")) {
    throw new Error("Installed package help output did not identify secant.");
  }

  if (versionOutput.trim() !== packageJson.version) {
    throw new Error(
      `Installed package reported version ${versionOutput.trim()} instead of ${packageJson.version}.`,
    );
  }

  process.stdout.write(
    `Installed package smoke passed for @secantdev/secant@${packageJson.version}.\n`,
  );
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
