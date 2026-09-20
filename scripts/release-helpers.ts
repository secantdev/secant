import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import which from "which";

type TFieldGuardParams = {
  readonly value: unknown;
  readonly field: string;
  readonly errorPrefix: string;
};

type TTextGuardParams = TFieldGuardParams & {
  readonly rejectWhitespace?: boolean;
};

type TReadManifestParams = {
  readonly path: string;
  readonly missingMessage: string;
  readonly invalidJsonMessage?: string;
};

type TRunGitParams = {
  readonly args: readonly string[];
  readonly cwd?: string;
};

type TNpmInstallParams = {
  readonly tarballs: readonly string[];
  readonly cwd: string;
  readonly omitOptional?: boolean;
};

export function fail(message: string, cause?: unknown): never {
  throw new Error(message, cause === undefined ? undefined : { cause });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(params: TFieldGuardParams): Record<string, unknown> {
  if (!isRecord(params.value)) {
    fail(`${params.errorPrefix}: ${params.field}.`);
  }
  return params.value;
}

export function text(params: TTextGuardParams): string {
  const invalid =
    typeof params.value !== "string" ||
    (params.rejectWhitespace
      ? params.value.trim().length === 0
      : params.value.length === 0);
  if (invalid) fail(`${params.errorPrefix}: ${params.field}.`);
  return params.value;
}

export function readManifest(params: TReadManifestParams): unknown {
  if (!existsSync(params.path)) fail(params.missingMessage);
  try {
    return JSON.parse(readFileSync(params.path, "utf8"));
  } catch (error) {
    if (
      error instanceof SyntaxError &&
      params.invalidJsonMessage !== undefined
    ) {
      fail(params.invalidJsonMessage, error);
    }
    throw error;
  }
}

/** Hash a file incrementally so large release artifacts are never buffered whole. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Run Git without interpreting its result; each caller owns failure policy. */
export function runGit(params: TRunGitParams): SpawnSyncReturns<string> {
  return spawnSync("git", Array.from(params.args), {
    cwd: params.cwd,
    encoding: "utf8",
  });
}

/** Install local tarballs with lifecycle scripts disabled. On Windows this runs
 *  Node against npm-cli.js beside the resolved npm shim, avoiding the unsupported
 *  bare `.cmd` spawn (#21); POSIX runs npm directly. Callers may omit optional
 *  dependencies when they supply the matching package tarball explicitly. */
export function npmInstall(
  params: TNpmInstallParams,
): SpawnSyncReturns<string> {
  const args = ["install"];
  for (const tarball of params.tarballs) args.push(tarball);
  args.push("--ignore-scripts");
  if (params.omitOptional) args.push("--omit=optional");
  args.push("--no-save", "--no-package-lock", "--no-audit", "--no-fund");

  if (process.platform !== "win32") {
    return spawnSync("npm", args, { cwd: params.cwd, encoding: "utf8" });
  }
  const npmShim = which.sync("npm");
  const npmCli = join(
    dirname(npmShim),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!existsSync(npmCli)) {
    fail(`npm CLI not found beside ${npmShim} (looked for ${npmCli}).`);
  }
  return spawnSync("node", [npmCli].concat(args), {
    cwd: params.cwd,
    encoding: "utf8",
  });
}
