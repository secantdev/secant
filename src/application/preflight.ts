import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  flattenSteps,
  type AuthoredManifest,
  type CommandParams,
  type CompositionFinding,
  type LaunchInput,
  type Platform,
  type Step,
} from "../workflow/workflow.js";
import { EXECUTABLE_STEP_KINDS } from "../run/execution/execution.js";
import type { FieldViolation, Problem } from "./projection-port.js";

// Preflight: the Application-owned precondition gate that refuses to create a Run
// whose prerequisites are not met and says exactly why (#14, spec #76). It runs
// at launch, before a Run exists, after the pinned bytes are read and inspected
// and before `runGroup.createRun`, so a failed Preflight leaves no Run directory,
// record, or Trust grant. It checks — in order — that the pinned Snapshot still
// composes, that every Step kind can be dispatched in this release, that every
// declared Launch input is present and valid for its Artifact type, that the
// union of authored Workspace prerequisites holds, and that each selected Command
// step's executable resolves on `PATH`.
//
// The two world probes — the `git-worktree-root` probe and `PATH` resolution —
// live here and stay private to Preflight (topology.md, glossary): Git has no
// Step kind and no public Module, and Command executable resolution is not a
// shared utility. Both translate their external result into a typed Problem here;
// presentation only formats it.

export interface PreflightRequest {
  readonly manifest: AuthoredManifest;
  /** The Composition findings from re-inspecting the pinned Snapshot's bytes. */
  readonly composition: readonly CompositionFinding[];
  /** The canonical launch Workspace path (Application already canonicalised it). */
  readonly workspacePath: string;
  /** Launch inputs by name, opaque strings, as the caller supplied them. */
  readonly launchInputs: Readonly<Record<string, string>>;
  /** The host platform the Run will execute on; picks which invocation resolves. */
  readonly hostPlatform: Platform | undefined;
  /** The pinned Snapshot digest, for the corrupted-Bundle Problem. */
  readonly digest: string;
}

export type PreflightResult =
  { readonly ok: true } | { readonly problem: Problem };

/** Run Preflight against a pinned Snapshot. Returns the first failing check as a
 *  Problem, or `ok` when every prerequisite holds. */
export function preflight(request: PreflightRequest): PreflightResult {
  const { manifest, composition, launchInputs, workspacePath } = request;
  const steps = flattenSteps(manifest.routing);

  // 1. The pinned Snapshot must still compose. A launch re-checks it because a Run
  // pins a Snapshot (ADR 0021); a failing re-check means corrupted installed bytes.
  // The Problem carries no routing vocabulary — the findings inform it, unprinted.
  if (composition.some((finding) => finding.severity === "error")) {
    return { problem: bundleSnapshotCorrupt(request.digest) };
  }

  // 2. Every Step kind must be dispatchable in this release. A kind with no
  // executor (Agent, Interactive agent, Human Gate) is an intrinsic precondition
  // failure — this is how the Proof Bundle is refused until the interactive path.
  const dispatchable = new Set<string>(EXECUTABLE_STEP_KINDS);
  for (const step of steps) {
    if (!dispatchable.has(step.kind)) {
      return { problem: stepKindNotExecutable(step) };
    }
  }

  // 3. Every declared Launch input is required and validated by its Artifact type;
  // one field violation per input, valid inputs pin to the Run unchanged (AC4).
  const violations = inputViolations(manifest.inputs, launchInputs);
  if (violations.length > 0) {
    return { problem: launchInputsInvalid(violations) };
  }

  // 4. The union of authored Workspace prerequisites. V1 has one: git-worktree-root.
  const prerequisites = new Set<string>();
  for (const step of steps) {
    for (const prerequisite of step.prerequisites ?? []) {
      prerequisites.add(prerequisite);
    }
  }
  if (prerequisites.has("git-worktree-root")) {
    const probe = probeGitWorktreeRoot(workspacePath);
    if ("problem" in probe) return probe;
  }

  // 5. Each selected Command step's executable resolves on PATH, ahead of the Run
  // (execution treats a missing binary as a failed Attempt; Preflight refuses it).
  const platforms = manifest.platforms ?? [];
  const platform = selectPlatform(platforms, request.hostPlatform);
  for (const step of steps) {
    if (step.kind !== "command") continue;
    const executable = selectExecutable(step.command, platform);
    if (!executableOnPath(executable)) {
      return { problem: commandExecutableNotFound(step.id, executable) };
    }
  }

  return { ok: true };
}

// --- Launch input validation -----------------------------------------------

/** One violation per declared input that is missing or invalid for its type. */
function inputViolations(
  declared: Readonly<Record<string, LaunchInput>>,
  supplied: Readonly<Record<string, string>>,
): FieldViolation[] {
  const violations: FieldViolation[] = [];
  for (const [name, input] of Object.entries(declared)) {
    const value = supplied[name];
    if (value === undefined) {
      violations.push({
        field: name,
        explanation: "is required but was not provided.",
      });
      continue;
    }
    const reason = invalidReason(input, value);
    if (reason !== undefined)
      violations.push({ field: name, explanation: reason });
  }
  return violations;
}

/** Why a supplied value is invalid for its declared Artifact type, or undefined
 *  when it is valid. Text is opaque (non-empty only); file/file-set touch the real
 *  filesystem; choice and verdict are closed sets. */
function invalidReason(input: LaunchInput, value: string): string | undefined {
  switch (input.type) {
    case "text":
      return value.length === 0 ? "must be non-empty text." : undefined;
    case "file":
      return isNonEmptyFile(value)
        ? undefined
        : `"${value}" is not an existing non-empty file.`;
    case "file-set": {
      // ponytail: a file-set value is newline-separated paths — the one encoding
      // that never collides with a path character. The `--input` CLI cannot pass
      // newlines yet; firm this up when a structured multi-file input surface lands.
      const paths = value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (paths.length === 0) return "must name at least one existing file.";
      const missing = paths.find((path) => !isExistingFile(path));
      return missing === undefined
        ? undefined
        : `"${missing}" is not an existing file.`;
    }
    case "choice": {
      const choices = input.choices ?? [];
      return choices.includes(value)
        ? undefined
        : `must be one of: ${choices.join(", ") || "(none declared)"}.`;
    }
    case "verdict":
      return value === "pass" || value === "fail"
        ? undefined
        : 'must be "pass" or "fail".';
  }
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isNonEmptyFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

// --- git-worktree-root probe (private to Preflight) ------------------------

/** Prove Git is runnable and the Workspace is the root of a non-bare worktree.
 *  Linked and unborn (no-commit) worktrees qualify; a subdirectory, a bare repo,
 *  and a plain directory do not. GIT_CONFIG_NOSYSTEM/GLOBAL keep the result
 *  independent of the host's Git config (mirrors the Artifact repo's hardening). */
function probeGitWorktreeRoot(workspacePath: string): PreflightResult {
  // Prove Git is runnable through the same PATH resolution the Command check uses,
  // so "Git absent" is a deterministic decision, not a spawn-lookup side effect.
  if (!executableOnPath("git")) {
    return { problem: gitNotRunnable() };
  }
  const result = spawnSync(
    "git",
    ["-C", workspacePath, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "" },
    },
  );
  if (result.error !== undefined) {
    return { problem: gitNotRunnable() };
  }
  if (result.status !== 0) {
    // Not a repository, or a bare repository (no working tree): prerequisite fails.
    return { problem: worktreeRootFailed(workspacePath) };
  }
  const toplevel = result.stdout.trim();
  let canonicalTop: string;
  try {
    canonicalTop = realpathSync.native(toplevel);
  } catch {
    return { problem: worktreeRootFailed(workspacePath) };
  }
  // A subdirectory of a worktree resolves to a toplevel above the Workspace.
  return canonicalTop === workspacePath
    ? { ok: true }
    : { problem: worktreeRootFailed(workspacePath) };
}

// --- PATH resolution (private to Preflight) --------------------------------

/** The Command invocation's executable for the selected platform: the platform
 *  override's `executable` if it names one, else the base (mirrors execution's
 *  `resolveInvocation` and the trust summary's platform selection). */
function selectExecutable(command: CommandParams, platform: Platform): string {
  return command.platforms?.[platform]?.executable ?? command.executable;
}

/** The platform whose invocation will run: the host when the Bundle supports it,
 *  else the first declared platform (mirrors `bundleTrustRequired`). */
function selectPlatform(
  platforms: readonly Platform[],
  host: Platform | undefined,
): Platform {
  if (host !== undefined && platforms.includes(host)) return host;
  return platforms[0] ?? "linux";
}

/** Whether a bare executable name resolves on the current PATH, the way spawnSync
 *  will resolve it — walking PATH entries, and PATHEXT extensions on Windows.
 *  ponytail: no cross-spawn-class `.cmd`/`.bat` shim special-casing beyond
 *  PATHEXT; add it if a Windows shim executable is ever authored (#83 scope). */
function executableOnPath(executable: string): boolean {
  // The manifest validator refuses absolute or shell-shaped executables, so a
  // name with a separator is defensive only: resolve it directly.
  if (executable.includes("/") || executable.includes("\\")) {
    return isExistingFile(executable);
  }
  const dirs = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir.length > 0);
  // On Windows try the bare name first (an executable authored with its own
  // extension, e.g. `bun.exe`, resolves as-is) and then each PATHEXT extension
  // (a bare `git` resolves as `git.EXE`); appending only PATHEXT would miss the
  // former.
  const extensions =
    process.platform === "win32"
      ? [
          "",
          ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter(Boolean),
        ]
      : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      if (isExistingFile(join(dir, executable + extension))) return true;
    }
  }
  return false;
}

// --- Problems --------------------------------------------------------------

function bundleSnapshotCorrupt(digest: string): Problem {
  return {
    code: "bundle-snapshot-corrupt",
    explanation: `The installed Bundle (digest ${digest}) is corrupted and can no longer be launched.`,
    remediation:
      "Reinstall the Bundle to restore an intact copy, then launch again.",
    possibleEffects: "none",
    details: { digest },
  };
}

function stepKindNotExecutable(step: Step): Problem {
  return {
    code: "step-kind-not-executable",
    explanation: `Step "${step.id}" is a ${step.kind} Step, which has no headless execution in this release.`,
    remediation:
      "Run this Bundle from the interactive terminal (available in a later milestone); this release runs Command-only Bundles.",
    possibleEffects: "none",
    details: { step: step.id, kind: step.kind },
  };
}

function launchInputsInvalid(violations: readonly FieldViolation[]): Problem {
  return {
    code: "launch-input-invalid",
    explanation: "One or more required Launch inputs are missing or invalid.",
    remediation:
      "Provide each listed input with a value of its declared type, then launch again.",
    possibleEffects: "none",
    fieldViolations: violations,
  };
}

function gitNotRunnable(): Problem {
  return {
    code: "workspace-prerequisite-failed",
    explanation:
      "The Bundle requires the launch Workspace to be a Git worktree root (git-worktree-root), but Git is not runnable on this system.",
    remediation: "Install Git and make sure it is on PATH, then launch again.",
    possibleEffects: "none",
    details: { prerequisite: "git-worktree-root" },
  };
}

function worktreeRootFailed(workspacePath: string): Problem {
  return {
    code: "workspace-prerequisite-failed",
    explanation: `The Bundle requires the launch Workspace to be the root of a non-bare Git worktree (git-worktree-root), but ${workspacePath} is not.`,
    remediation:
      "Launch from the root of a Git worktree — run `git init` there, or change to the worktree root — then launch again.",
    possibleEffects: "none",
    details: { prerequisite: "git-worktree-root", path: workspacePath },
  };
}

function commandExecutableNotFound(
  stepId: string,
  executable: string,
): Problem {
  return {
    code: "command-executable-not-found",
    explanation: `Command step "${stepId}" needs the executable "${executable}", which is not on PATH.`,
    remediation: `Install "${executable}" and make sure it is on PATH, then launch again.`,
    possibleEffects: "none",
    details: { step: stepId, executable },
  };
}
