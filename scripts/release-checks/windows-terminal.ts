#!/usr/bin/env bun
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { release, tmpdir, version as osVersion } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { formatWindowsTerminalReport } from "./windows-terminal-report.js";
import { sha256File } from "./release-evidence.js";

const HELP = `Windows Terminal human real-terminal check

Usage:
  bun run check:windows-terminal [path-to-secant-windows-x64.exe]

Run this from a Windows Terminal tab after \`bun run check\`. The script checks
the packed binary, guides both supported exit paths and the observed-only
legacy-conhost run, then prints the digest-bound release evidence report.`;

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly packageManager: string;
}

interface CheckContext {
  readonly binary: string;
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
}

function fail(message: string, cause?: unknown): never {
  throw new Error(message, cause === undefined ? undefined : { cause });
}

function validateManifest(value: unknown): PackageManifest {
  if (typeof value !== "object" || value === null) {
    fail("package.json must contain an object.");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.name !== "@secantdev/secant") {
    fail("package.json must name the @secantdev/secant package.");
  }
  if (
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
  ) {
    fail("package.json must contain a valid package version.");
  }
  if (
    typeof manifest.packageManager !== "string" ||
    !/^bun@\d+\.\d+\.\d+$/.test(manifest.packageManager)
  ) {
    fail("package.json must contain an exact Bun packageManager pin.");
  }
  return {
    name: manifest.name,
    version: manifest.version,
    packageManager: manifest.packageManager,
  };
}

function checkSpawn(result: SpawnSyncReturns<unknown>, action: string): void {
  if (result.error) fail(`Could not ${action}.`, result.error);
  if (result.signal)
    fail(`${action} was terminated by signal ${result.signal}.`);
}

async function askYesNo(
  prompt: ReturnType<typeof createInterface>,
  question: string,
): Promise<boolean> {
  for (;;) {
    const answer = (await prompt.question(`${question} [y/n] `))
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("Please answer y or n.");
  }
}

async function askTerminalVersion(
  prompt: ReturnType<typeof createInterface>,
): Promise<string> {
  for (;;) {
    const answer = (
      await prompt.question(
        "Windows Terminal version (the numeric value under Settings > About): ",
      )
    ).trim();
    if (/^\d+(?:\.\d+){1,3}$/.test(answer)) return answer;
    console.log("Enter the numeric version, for example 1.23.1234.0.");
  }
}

function approveWorkspace(context: CheckContext): void {
  const result = spawnSync(context.binary, ["workspace", "approve"], {
    cwd: context.workspace,
    env: context.env,
    encoding: "utf8",
  });
  checkSpawn(result, "start Secant to approve the temporary Workspace");
  if (result.status !== 0) {
    fail(
      `Could not approve the temporary Workspace (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function runExitPath(
  prompt: ReturnType<typeof createInterface>,
  context: CheckContext,
  key: "q" | "Ctrl+C",
): Promise<boolean> {
  console.log(
    `\nSecant will start in this Windows Terminal tab. Wait for Home, press ${key}, and do not close the tab.`,
  );
  await prompt.question("Press Enter to launch Secant. ");
  const result = spawnSync(context.binary, [], {
    cwd: context.workspace,
    env: context.env,
    stdio: "inherit",
  });
  checkSpawn(result, `start Secant for the ${key} exit path`);
  const responsive = await askYesNo(
    prompt,
    "Did Secant exit and leave this tab responsive at a normal prompt?",
  );
  if (result.status !== 0) {
    console.log(
      `Secant exited with status ${String(result.status)}; this row fails.`,
    );
  }
  return result.status === 0 && responsive;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (process.platform !== "win32") fail("This check must run on Windows.");
  if (!process.env.WT_SESSION) {
    fail(
      "Run this check from a Windows Terminal tab (WT_SESSION is not set in this process).",
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("This check requires an interactive terminal.");
  }

  const projectRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const manifest = validateManifest(
    JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")),
  );
  const bunPin = manifest.packageManager.match(/^bun@(.+)$/)?.[1];
  if (!bunPin)
    fail("package.json does not contain an exact Bun packageManager pin.");
  if (Bun.version !== bunPin) {
    fail(
      `This check requires the repository Bun pin ${bunPin}; running ${Bun.version}.`,
    );
  }

  const binary = resolve(
    process.argv[2] ?? join(projectRoot, "dist", "secant-windows-x64.exe"),
  );
  if (!existsSync(binary)) {
    fail(
      `Compiled binary not found at ${binary}. Run \`bun run check\` first.`,
    );
  }
  const versionResult = spawnSync(binary, ["--version"], { encoding: "utf8" });
  checkSpawn(versionResult, "start the compiled binary for its version check");
  const binaryVersion = versionResult.stdout.trim();
  if (versionResult.status !== 0 || binaryVersion !== manifest.version) {
    fail(
      `The binary is not the current ${manifest.name}@${manifest.version} build (reported ${binaryVersion || "no version"}). Run \`bun run check\` again.`,
    );
  }

  const digest = await sha256File(binary);
  const checkRoot = mkdtempSync(join(tmpdir(), "secant-human-terminal-"));
  const home = join(checkRoot, "home");
  const workspace = join(checkRoot, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  const env = { ...process.env, SECANT_HOME: home };
  const context = { binary, workspace, env };
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    approveWorkspace(context);
    console.log(`Checking ${manifest.name}@${manifest.version}`);
    console.log(`SHA-256 ${digest}`);
    const terminalVersion = await askTerminalVersion(prompt);

    const quitBindingPassed = await runExitPath(prompt, context, "q");
    const ctrlCPassed = await runExitPath(prompt, context, "Ctrl+C");

    console.log(`
Observed-only legacy conhost row (this does not decide the outcome):
1. Press Win+R, enter: conhost.exe powershell.exe
2. In that legacy window, paste these three lines:
   $env:SECANT_HOME = ${quotePowerShell(home)}
   Set-Location -LiteralPath ${quotePowerShell(workspace)}
   & ${quotePowerShell(binary)}
3. Wait for Home, note whether the startup notice appeared, press q, then test
   whether the same window still accepts input. Close it when finished.
4. Return to this Windows Terminal tab and answer the two questions.`);
    await prompt.question(
      "Press Enter after the conhost observation is complete. ",
    );
    const conhostNoticeAppeared = await askYesNo(
      prompt,
      "Did the legacy-conhost startup notice appear?",
    );
    const conhostWindowSurvived = await askYesNo(
      prompt,
      "Did the conhost window survive and remain responsive after q?",
    );

    const report = formatWindowsTerminalReport({
      report: {
        checkName: "Windows Terminal human real-terminal check",
        operatingSystem: {
          name: "Windows",
          version: `${osVersion()} (${release()})`,
        },
        subject: {
          kind: "terminal",
          name: "Windows Terminal",
          version: terminalVersion,
        },
        bunVersion: bunPin,
        secantVersion: manifest.version,
        binarySha256: digest,
        outcome: quitBindingPassed && ctrlCPassed ? "pass" : "fail",
        timestamp: new Date().toISOString(),
      },
      evidence: { kind: "fresh" },
      quitBindingPassed,
      ctrlCPassed,
      conhostNoticeAppeared,
      conhostWindowSurvived,
    });
    console.log("\nPaste the report below into the release checklist:\n");
    console.log(report);
  } finally {
    prompt.close();
    try {
      rmSync(checkRoot, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `Warning: could not remove temporary check directory ${checkRoot}: ${String(error)}`,
      );
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
    if (error.cause !== undefined)
      console.error(`Caused by: ${String(error.cause)}`);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
