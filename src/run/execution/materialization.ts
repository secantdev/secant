import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Reference, Step } from "../../workflow/workflow.js";
import type { CandidateOutput, RunOwner } from "../store/store.js";

interface StepContext {
  readonly owner: RunOwner;
}

// --- Workspace materialization and verification (#88, ADR 0023) -------------

/** A detected Materialization conflict, ready to record. */
interface DetectedConflict {
  readonly artifactName: string;
  readonly path: string;
  readonly versionId: string;
  readonly diagnostic: Uint8Array;
  readonly at: Date;
}

/** Artifact name → declared relative Workspace path for every `home: workspace`
 *  output any Step produces. An output with no `path` cannot be placed, so it is
 *  skipped (the Composition check is the authority that a workspace home has one). */
export function collectMaterializations(
  steps: readonly Step[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const step of steps) {
    for (const produced of step.produces ?? []) {
      if (produced.home === "workspace" && produced.path !== undefined) {
        map.set(produced.name, produced.path);
      }
    }
  }
  return map;
}

/** Verify every `home: workspace` Artifact this Step is about to use. Returns the
 *  first conflict, or undefined when every copy matches its bound version. */
export function verifyMaterializations(
  step: Step,
  context: StepContext,
  materializations: ReadonlyMap<string, string>,
  at: Date,
): DetectedConflict | undefined {
  const workspacePath = context.owner.record.workspacePath;
  for (const name of stepReferences(step)) {
    const relPath = materializations.get(name);
    if (relPath === undefined) continue; // not Workspace-materialized
    const versionId = context.owner.currentVersion(name);
    if (versionId === undefined) continue; // not bound yet — nothing to verify
    const bound = context.owner.readArtifact(versionId, name);
    if (bound === undefined) continue; // no bytes at the bound version
    const copy = readWorkspaceCopy(workspacePath, relPath);
    if (copy !== undefined && bytesEqual(copy, bound)) continue; // matches
    return {
      artifactName: name,
      path: relPath,
      versionId,
      diagnostic: new TextEncoder().encode(
        conflictDiagnostic(name, relPath, versionId, bound, copy),
      ),
      at,
    };
  }
  return undefined;
}

/** Write each `home: workspace` output this Step produced into the Workspace at
 *  its declared path, byte-for-byte (AC1/AC4). */
export function materializeOutputs(
  step: Step,
  outputs: readonly CandidateOutput[],
  context: StepContext,
): void {
  const wanted = new Map<string, string>();
  for (const produced of step.produces ?? []) {
    if (produced.home === "workspace" && produced.path !== undefined) {
      wanted.set(produced.name, produced.path);
    }
  }
  if (wanted.size === 0) return;
  const workspacePath = context.owner.record.workspacePath;
  for (const output of outputs) {
    const relPath = wanted.get(output.name);
    if (relPath === undefined) continue;
    const target = resolveWorkspacePath(workspacePath, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output.content);
  }
}

/** The artifact names a Step uses: everything it `requires`, plus every
 *  `{artifact}` a Command resolves in its arguments or env (base and any platform
 *  override). Verification runs over these before the Step executes. */
function stepReferences(step: Step): Set<string> {
  const names = new Set<string>(step.requires ?? []);
  if (step.kind === "command") {
    collectArtifactTokens(step.command, names);
    for (const override of Object.values(step.command.platforms ?? {})) {
      if (override !== undefined) collectArtifactTokens(override, names);
    }
  }
  return names;
}

function collectArtifactTokens(
  invocation: {
    readonly arguments?: readonly (string | Reference)[];
    readonly env?: Readonly<Record<string, string | Reference>>;
  },
  into: Set<string>,
): void {
  for (const token of invocation.arguments ?? []) {
    if (typeof token !== "string" && "artifact" in token)
      into.add(token.artifact);
  }
  for (const value of Object.values(invocation.env ?? {})) {
    if (typeof value !== "string" && "artifact" in value)
      into.add(value.artifact);
  }
}

/** Resolve a declared relative Workspace path identically on Windows and POSIX
 *  (AC4): split on either separator and re-join under the Workspace root. */
export function resolveWorkspacePath(
  workspacePath: string,
  relPath: string,
): string {
  return join(
    workspacePath,
    ...relPath.split(/[\\/]+/).filter((segment) => segment.length > 0),
  );
}

/** The current Workspace bytes at a declared path, or undefined if it is absent. */
function readWorkspaceCopy(
  workspacePath: string,
  relPath: string,
): Uint8Array | undefined {
  const target = resolveWorkspacePath(workspacePath, relPath);
  try {
    return existsSync(target) ? readFileSync(target) : undefined;
  } catch {
    return undefined;
  }
}

/** Exact byte comparison — no line-ending or encoding normalization (AC4). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(a, b) === 0;
}

/** The human-readable diagnostic for a conflict: names the artifact, the path,
 *  the bound version, and whether the copy is missing or changed. */
function conflictDiagnostic(
  name: string,
  relPath: string,
  versionId: string,
  bound: Uint8Array,
  copy: Uint8Array | undefined,
): string {
  const state =
    copy === undefined
      ? "the Workspace copy is missing"
      : `the Workspace copy changed (expected ${bound.length} bytes, found ${copy.length})`;
  return (
    [
      `Materialization conflict for artifact "${name}" at Workspace path "${relPath}".`,
      `Before a Step could use it, ${state}; it no longer matches the bound version ${versionId}.`,
      "Secant halted the Run without overwriting the Workspace or adopting its bytes (ADR 0023).",
      `Restore "${relPath}" to its bound content and resume the Run.`,
    ].join("\n") + "\n"
  );
}

export function recordConflictOrThrow(
  owner: RunOwner,
  conflict: DetectedConflict,
): void {
  const result = owner.recordMaterializationConflict({
    artifactName: conflict.artifactName,
    path: conflict.path,
    versionId: conflict.versionId,
    diagnostic: conflict.diagnostic,
    at: conflict.at,
  });
  // A fenced owner mid-Run means another process took over; stopping is correct
  // and throwing hands that to composition, like writeStateOrThrow.
  if (!result.ok) {
    throw new Error(
      `execution: cannot record a Materialization conflict: ${result.reason}.`,
    );
  }
}
