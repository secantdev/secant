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

export interface RepeatBundleOptions {
  readonly id?: string;
  readonly version?: string;
  /** The Review checkpoint cadence. */
  readonly interval: number;
  readonly message?: string;
  /** The `check` Command exits 0 (a `pass` Verdict) on its `passAt`th iteration.
   *  Omit to make it always fail (exit 1), so the group blocks at the checkpoint. */
  readonly passAt?: number;
  /** The `check` Step's retry budget. */
  readonly retry?: number;
  /** Make the baseline bind `passing` = pass, so the group runs zero iterations. */
  readonly baselinePass?: boolean;
}

// A Repeat-group Bundle authoring folder (#84): a baseline Command binds the
// `until` Verdict `passing` before the group is entered (Composition requires it),
// then a group loops a `check` Command until `passing` reads `pass`. Command-only
// and cross-OS like `writeCommandBundle`. When `passAt` is set, `check` counts its
// iterations through a per-Bundle counter file so its Verdict flips to `pass` on
// the `passAt`th run.
export function writeRepeatBundle(options: RepeatBundleOptions): CommandBundle {
  const id = options.id ?? "dev.secant.repeat-loop";
  const version = options.version ?? "1.0.0";
  const folder = makeTempDir("secant-repeat-bundle-");
  const counter = join(makeTempDir("secant-repeat-counter-"), "counter");

  const baselineScript = options.baselinePass
    ? "process.exit(0)"
    : "process.exit(1)";
  const checkScript =
    options.passAt === undefined
      ? "process.exit(1)"
      : `const fs=require('node:fs');const p=${JSON.stringify(counter)};` +
        `let n=0;try{n=Number(fs.readFileSync(p,'utf8'))||0;}catch{}` +
        `n++;fs.writeFileSync(p,String(n));` +
        `console.log('iteration '+n);process.exit(n>=${options.passAt}?0:1);`;

  const manifest = {
    formatVersion: 1,
    bundle: {
      id,
      version,
      name: "Repeat Loop",
      description: "A repeat-group test Bundle.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [],
    routing: [
      {
        id: "baseline",
        kind: "command",
        produces: [{ name: "passing", type: "verdict" }],
        command: {
          executable: RUNTIME_NAME,
          arguments: ["-e", baselineScript],
        },
      },
      {
        repeat: {
          until: "passing",
          reviewCheckpoint: {
            interval: options.interval,
            message: options.message ?? "please review the loop",
          },
          steps: [
            {
              id: "check",
              kind: "command",
              ...(options.retry !== undefined ? { retry: options.retry } : {}),
              produces: [
                { name: "passing", type: "verdict" },
                { name: "log", type: "text" },
              ],
              command: {
                executable: RUNTIME_NAME,
                arguments: ["-e", checkScript],
              },
            },
          ],
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

export interface MaterializationBundleOptions {
  readonly id?: string;
  readonly version?: string;
  /** The resolved absolute launch Workspace, so the tamper Step can target the
   *  materialized file by absolute path (Command Steps do not run in the
   *  Workspace). */
  readonly workspaceAbsPath: string;
  /** How the middle Step disturbs the materialized copy before the last Step uses
   *  it: `"modify"` rewrites it, `"delete"` removes it, `"none"` leaves it. */
  readonly tamper: "modify" | "delete" | "none";
  /** The declared relative Workspace path for the produced Artifact. */
  readonly path?: string;
  /** The bytes the producing Step writes (its captured stdout). */
  readonly content?: string;
}

/** A three-Step Bundle for #88: `produce` writes a `home: workspace` text
 *  Artifact `x`; an optional `tamper` disturbs the Workspace copy; `consume`
 *  references `x` (so it verifies the copy before running). Command-only, so the
 *  M2 scheduler drives it, and every command names the runtime by bare name. */
export function writeMaterializationBundle(
  options: MaterializationBundleOptions,
): CommandBundle {
  const id = options.id ?? "dev.secant.materialize";
  const version = options.version ?? "1.0.0";
  const relPath = options.path ?? "out/x.txt";
  const content = options.content ?? "materialized-content";
  const absX = join(options.workspaceAbsPath, ...relPath.split("/"));
  const routing: unknown[] = [
    {
      id: "produce",
      kind: "command",
      produces: [{ name: "x", type: "text", home: "workspace", path: relPath }],
      command: {
        executable: RUNTIME_NAME,
        arguments: ["-e", `process.stdout.write(${JSON.stringify(content)})`],
      },
    },
  ];
  if (options.tamper !== "none") {
    const script =
      options.tamper === "modify"
        ? `require('node:fs').writeFileSync(${JSON.stringify(absX)}, 'CHANGED')`
        : `require('node:fs').rmSync(${JSON.stringify(absX)})`;
    routing.push({
      id: "tamper",
      kind: "command",
      produces: [{ name: "tamperlog", type: "text" }],
      command: { executable: RUNTIME_NAME, arguments: ["-e", script] },
    });
  }
  routing.push({
    id: "consume",
    kind: "command",
    requires: ["x"],
    produces: [{ name: "y", type: "text" }],
    command: {
      executable: RUNTIME_NAME,
      arguments: ["-e", "process.stdout.write('done')", { artifact: "x" }],
    },
  });
  const manifest = {
    formatVersion: 1,
    bundle: {
      id,
      version,
      name: "Materialize",
      description: "A workspace-materialization test Bundle.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [],
    routing,
  };
  const folder = makeTempDir("secant-mat-bundle-");
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
