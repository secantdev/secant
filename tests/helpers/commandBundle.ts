import { delimiter, basename, dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import type {
  LaunchInput,
  Platform,
  WorkspacePrerequisite,
} from "../../src/workflow/workflow.js";
import { makeTempDir } from "./tempDir.js";

// A straight-line, single-Command Bundle authoring folder whose command runs the
// current runtime binary by its bare name (the manifest validator refuses an
// absolute or shell-shaped executable) — so it works on every OS the tests run
// on. Command-only, so the M2 Run scheduler can drive it.

/** The runtime binary's bare name (e.g. "bun"), which the manifest validator
 *  accepts and `spawnSync` resolves on PATH. */
export const RUNTIME_NAME = basename(process.execPath);

/** Ensure the current runtime's directory is on PATH, so a Command that names it
 *  by its bare name resolves when the Run scheduler spawns it. */
export function ensureRuntimeOnPath(): void {
  const dir = dirname(process.execPath);
  const path = process.env.PATH ?? "";
  if (!path.split(delimiter).includes(dir)) {
    process.env.PATH = path === "" ? dir : `${dir}${delimiter}${path}`;
  }
}

export interface CommandBundleOptions {
  readonly id?: string;
  readonly version?: string;
  /** JS run via the runtime's `-e`; default prints and exits 0 (a `pass`). */
  readonly script?: string;
  /** Override the command executable. A bare name that resolves to nothing forces
   *  every Attempt to fail so the Run rests `failed`. */
  readonly executable?: string;
  /** The Step's retry budget; keep failing Runs fast with 0. */
  readonly retry?: number;
  /** Run the command as `<runtime> {asset}` against a written script asset,
   *  instead of `-e`. Exercises the `{asset}` → on-disk-path resolver. */
  readonly asset?: { readonly path: string; readonly content: string };
  /** Workspace prerequisites the command Step requires (e.g. git-worktree-root),
   *  so Preflight's world probes are exercised. */
  readonly prerequisites?: readonly WorkspacePrerequisite[];
  /** Declared Launch inputs, so Preflight's per-input validation is exercised. */
  readonly inputs?: Readonly<Record<string, LaunchInput>>;
}

export interface CommandBundle {
  readonly folder: string;
  readonly id: string;
  readonly version: string;
}

export function writeCommandBundle(
  options: CommandBundleOptions = {},
): CommandBundle {
  const id = options.id ?? "dev.secant.command-only";
  const version = options.version ?? "1.0.0";
  const script = options.script ?? "console.log('ran')";
  const folder = makeTempDir("secant-cmd-bundle-");

  const assets: { path: string; kind: string }[] = [];
  let commandArgs: (string | { asset: string })[] = ["-e", script];
  if (options.asset !== undefined) {
    writeFileSync(join(folder, options.asset.path), options.asset.content);
    assets.push({ path: options.asset.path, kind: "script" });
    commandArgs = [{ asset: options.asset.path }];
  }

  const manifest = {
    formatVersion: 1,
    bundle: {
      id,
      version,
      name: "Command Only",
      description: "A command-only test Bundle.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: options.inputs ?? {},
    assets,
    routing: [
      {
        id: "run-check",
        kind: "command",
        ...(options.retry !== undefined ? { retry: options.retry } : {}),
        ...(options.prerequisites !== undefined
          ? { prerequisites: options.prerequisites }
          : {}),
        produces: [
          { name: "verdict", type: "verdict" },
          { name: "output", type: "text" },
        ],
        command: {
          executable: options.executable ?? RUNTIME_NAME,
          arguments: commandArgs,
        },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id, version };
}

/** The host platform, so a Run execution resolves the command deterministically. */
export function hostPlatform(): Platform {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}
