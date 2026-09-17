import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import {
  flattenSteps,
  STEP_KINDS,
  type AuthoredManifest,
  type CommandParams,
  type CompositionFinding,
  type LaunchInput,
  type Platform,
} from "../workflow/workflow.js";
import { CLAUDE_CODE_EXECUTABLE_ENV } from "../harness/harness.js";
import { resolveExecutable } from "../process/process.js";
import { isolatedGitEnvironment } from "../run/store/store.js";
import type { FieldViolation, Problem } from "./projection-port.js";
import { selectPlatform } from "./select-platform.js";

// The Harness capability needs Secant's one M3 Harness (Claude Code) serves. A
// Step kind declares its needs (`agent-turn`, `interactive-turns`); Preflight
// refuses a routing whose union is not a subset of this set before a Run exists
// (#116). Claude Code serves both; the check is the seam a future Harness that
// serves fewer would trip.
const HARNESS_SERVED_CAPABILITIES: ReadonlySet<string> = new Set([
  "agent-turn",
  "interactive-turns",
]);

// Preflight: the Application-owned precondition gate that refuses to create a Run
// whose prerequisites are not met and says exactly why (#14, spec #76). It runs
// at launch, before a Run exists, after the pinned bytes are read and inspected
// and before `runGroup.createRun`, so a failed Preflight leaves no Run directory,
// record, or Trust grant. It checks — in order — that the pinned Snapshot still
// composes, that a headless client is not handed an interactive-agent Step, that
// every declared Launch input is present and valid for its Artifact type, that the
// union of authored Workspace prerequisites holds, and that each selected Command
// step's executable resolves on `PATH`.
//
// The `git-worktree-root` probe stays private to Preflight (topology.md,
// glossary): Git has no Step kind and no public Module. Command executable
// resolution is *not* private: it is the process Module's exported resolver, which
// execution also spawns through, so Preflight's precondition and execution's spawn
// agree by construction (A40). Preflight translates each external result into a
// typed Problem; presentation only formats it.

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
  /** Whether the launching client can relay human turn-taking (#116). The headless
   *  client cannot, so it refuses an `interactive-agent` routing with the TUI
   *  remedy; the TUI sets this true. Defaults to false. */
  readonly supportsInteractiveTurns?: boolean;
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

  // 2. An `interactive-agent` Step needs human turn-taking the headless client
  // cannot relay (#116): refuse it with the TUI remedy. Every Step kind is now
  // dispatchable (the closed table has all four kinds, #122), so this is the only
  // kind-based Preflight refusal — the generic not-executable check is retired.
  if (request.supportsInteractiveTurns !== true) {
    const interactive = steps.find((step) => step.kind === "interactive-agent");
    if (interactive !== undefined) {
      return { problem: interactiveStepNeedsTui(interactive.id) };
    }
  }

  // 3. Harness discovery and the capability-need union (#116). Only when the
  // routing needs a Harness (a Step kind declaring capability needs). The union
  // must be a subset of what the Harness serves, and the executable must resolve
  // (configured command first, then the PATH name), or the launch is refused
  // before a Run exists — an Agent Step never discovers its Harness mid-Run.
  const capabilityNeeds = new Set<string>();
  for (const step of steps) {
    for (const need of STEP_KINDS[step.kind].capabilityNeeds) {
      capabilityNeeds.add(need);
    }
  }
  if (capabilityNeeds.size > 0) {
    const unmet = [...capabilityNeeds].filter(
      (need) => !HARNESS_SERVED_CAPABILITIES.has(need),
    );
    if (unmet.length > 0) {
      return { problem: harnessCapabilityUnmet(unmet) };
    }
    const discovered = discoverHarness();
    if ("problem" in discovered) return discovered;
  }

  // 5. Every declared Launch input is required and validated by its Artifact type;
  // one field violation per input, valid inputs pin to the Run unchanged (AC4).
  const violations = inputViolations(manifest.inputs, launchInputs);
  if (violations.length > 0) {
    return { problem: launchInputsInvalid(violations) };
  }

  // 6. The union of authored Workspace prerequisites. V1 has one: git-worktree-root.
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

  // 7. Each selected Command step's executable resolves on PATH, ahead of the Run
  // (execution treats a missing binary as a failed Attempt; Preflight refuses it).
  const platforms = manifest.platforms ?? [];
  const platform = selectPlatform(platforms, request.hostPlatform);
  for (const step of steps) {
    if (step.kind !== "command") continue;
    const executable = selectExecutable(step.command, platform);
    // The same resolver execution spawns through, so a pass here means the Command
    // will spawn (A40): a missing binary is refused, and a Windows `.cmd`/`.bat`
    // that is not an npm-style node shim is refused with the interpreter remedy.
    const resolution = resolveExecutable(executable);
    if (resolution.kind === "not-found") {
      return { problem: commandExecutableNotFound(step.id, executable) };
    }
    if (resolution.kind === "unsupported-shim") {
      return {
        problem: commandExecutableUnsupportedShim(
          step.id,
          executable,
          resolution.path,
        ),
      };
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
 *  and a plain directory do not. It runs under the Run Store's
 *  `isolatedGitEnvironment()` so the host's Git config cannot change the result —
 *  the one hardening the Artifact repo also uses. */
function probeGitWorktreeRoot(workspacePath: string): PreflightResult {
  // Prove Git is runnable through the same resolver the Command check uses, so
  // "Git absent" is a deterministic decision, not a spawn-lookup side effect.
  if (resolveExecutable("git").kind !== "found") {
    return { problem: gitNotRunnable() };
  }
  const result = spawnSync(
    "git",
    ["-C", workspacePath, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      env: isolatedGitEnvironment(),
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

// --- Harness discovery (#116) ----------------------------------------------

/** Discover the Harness executable the way the Adapter does — the configured
 *  command (one M3 env var) first, then the canonical PATH name `claude` — through
 *  the same `process` resolver command steps use, so Preflight's precondition and
 *  the Adapter's spawn agree. An unsupported Windows shim fails immediately; a
 *  not-found on every attempt names what was searched. */
function discoverHarness(): PreflightResult {
  const configured = process.env[CLAUDE_CODE_EXECUTABLE_ENV]?.trim();
  const attempts: readonly { source: string; name: string }[] =
    configured !== undefined && configured.length > 0
      ? [
          {
            source: `configured command (${CLAUDE_CODE_EXECUTABLE_ENV})`,
            name: configured,
          },
          { source: "PATH name 'claude'", name: "claude" },
        ]
      : [{ source: "PATH name 'claude'", name: "claude" }];
  const searched: string[] = [];
  for (const attempt of attempts) {
    const resolution = resolveExecutable(attempt.name);
    if (resolution.kind === "found") return { ok: true };
    if (resolution.kind === "unsupported-shim") {
      return {
        problem: harnessUnsupportedShim(attempt.name, resolution.path),
      };
    }
    searched.push(`${attempt.source}: "${attempt.name}"`);
  }
  return { problem: harnessNotFound(searched) };
}

// --- Platform / executable selection ---------------------------------------

/** The Command invocation's executable for the selected platform: the platform
 *  override's `executable` if it names one, else the base (mirrors execution's
 *  `resolveInvocation` and the trust summary's platform selection). */
function selectExecutable(command: CommandParams, platform: Platform): string {
  return command.platforms?.[platform]?.executable ?? command.executable;
}

// --- Problems --------------------------------------------------------------

// A Bundle carrying an Agent Step needs a Harness on this system, but neither the
// configured command nor the PATH name `claude` resolved. Names exactly what was
// searched so the user can fix their environment (#116, spec story 29).
function harnessNotFound(searched: readonly string[]): Problem {
  return {
    code: "harness-not-found",
    explanation: `This Bundle runs an agent through Claude Code, which could not be found. Searched: ${searched.join("; ")}.`,
    remediation: `Install Claude Code and make sure it is on PATH, or set ${CLAUDE_CODE_EXECUTABLE_ENV} to its executable, then launch again.`,
    possibleEffects: "none",
    details: { searched: searched.join("; ") },
  };
}

// The configured Harness command or `claude` resolved to a Windows script shim
// Secant will not run through a shell; the user must name the real interpreter.
function harnessUnsupportedShim(name: string, path: string): Problem {
  return {
    code: "harness-unsupported-shim",
    explanation: `Claude Code "${name}" resolves to the Windows script shim "${path}", which Secant will not run through a shell.`,
    remediation: `Point ${CLAUDE_CODE_EXECUTABLE_ENV} at the real Claude Code executable (not a .cmd/.bat shim), then launch again.`,
    possibleEffects: "none",
    details: { name, path },
  };
}

// The routing's Step kinds need a Harness capability the selected Harness does not
// serve. Refused before a Run exists so the gap is never discovered mid-Run (#116,
// spec story 9). Inert for M3's Claude Code, which serves both known needs.
function harnessCapabilityUnmet(unmet: readonly string[]): Problem {
  return {
    code: "harness-capability-unmet",
    explanation: `The selected Harness cannot meet this Bundle's capability needs: ${unmet.join(", ")}.`,
    remediation:
      "Use a Harness that serves these capabilities, or a Bundle whose Steps do not need them.",
    possibleEffects: "none",
    details: { unmet: unmet.join(", ") },
  };
}

// A headless client cannot relay the human turn-taking an Interactive agent Step
// needs; run the Bundle in the TUI instead (#116, spec story 35).
function interactiveStepNeedsTui(stepId: string): Problem {
  return {
    code: "interactive-step-needs-tui",
    explanation: `Step "${stepId}" is an interactive-agent Step, which hands its Session to a human for turn-taking; the headless client cannot relay that.`,
    remediation: "Run this Bundle in the TUI.",
    possibleEffects: "none",
    details: { step: stepId },
  };
}

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

// A Windows `.cmd`/`.bat` that is not an npm-style node shim: Secant resolves an
// npm shim to its real target and spawns it directly, but never runs an arbitrary
// batch script through a shell (#21), so the author must name the real interpreter.
function commandExecutableUnsupportedShim(
  stepId: string,
  executable: string,
  path: string,
): Problem {
  return {
    code: "command-executable-unsupported-shim",
    explanation: `Command step "${stepId}" resolves "${executable}" to the Windows script shim "${path}", which Secant will not run through a shell.`,
    remediation:
      "Name the real interpreter and the script as the Command executable and arguments (for example the interpreter plus the script path) instead of the shim, then launch again.",
    possibleEffects: "none",
    details: { step: stepId, executable, path },
  };
}
