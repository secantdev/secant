import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ArtifactType,
  ProducedArtifact,
} from "../../../workflow/workflow.js";

// The Artifact Module owns a Run's private bare `artifacts.git`: it validates a
// Step Attempt's outputs against the Step contract, then stages ONE Git commit
// for the whole publication set (ADR 0023). The opaque commit id is the Artifact
// version id — Secant owns no version counter. The commit is invisible candidate
// storage until the Run Store's `run.db` transaction records it; only that
// transaction publishes. This Module is private to the Run Store (import
// direction `store -> artifacts`); there is no public Git Module.
//
// Git mechanics decision (re-earned per #80 under built-ins-first + the growth
// rule): shell out to the `git` executable, no library. The surface is frozen —
// init a bare repo, write a blob, make a flat tree, commit it, read a blob back —
// so there is nothing to grow. OpenCode solves the same problem (snapshotting
// state into a private git object store) by shelling out in two independent
// implementations rather than reaching for isomorphic-git/nodegit, on fidelity
// and no-dependency grounds; this follows that judgement. `node:child_process`
// is runtime-neutral, so no new dependency, notice, or Bun-API allowlist entry.
// A missing `git` binary is surfaced as a precise `git-unavailable` Problem.

/** A candidate output a producer wrote once, ready to publish. */
export interface StageOutput {
  readonly name: string;
  readonly type: ArtifactType;
  /** Portable regular-file bytes. */
  readonly content: Uint8Array;
}

/** Why a publication could not be staged, before anything is committed. */
export type StageProblem =
  | { readonly kind: "missing-output"; readonly name: string }
  | { readonly kind: "git-unavailable"; readonly detail: string };

export type StageResult =
  | { readonly ok: true; readonly versionId: string }
  | { readonly ok: false; readonly problem: StageProblem };

/** A Run's private Artifact object store. Bound to a Run directory; holds no OS
 *  handle (each operation spawns `git`), so there is nothing to close. */
export interface ArtifactRepo {
  /**
   * Validate that every required output is present with its declared type, then
   * stage one commit for the whole set. The Attempt id is mixed into the commit
   * so distinct Attempts never share a version id even with identical content,
   * while retrying the same Attempt reproduces it. Returns the commit id (the
   * version id) — candidate storage until the Run Store's publication
   * transaction records it.
   */
  stageCommit(
    attemptId: string,
    required: readonly ProducedArtifact[],
    outputs: readonly StageOutput[],
    at: Date,
  ): StageResult;
  /** The bytes of one artifact at a version, or undefined if that path is absent.
   *  Throws if the `git` executable is unavailable — that is an environment fault,
   *  not an absent artifact. */
  read(versionId: string, name: string): Uint8Array | undefined;
}

/** A single path segment: no slash, no traversal, so it is a safe flat tree name. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

class GitUnavailable extends Error {}

export function openArtifactRepo(runDir: string): ArtifactRepo {
  const gitDir = join(runDir, "artifacts.git");
  // GIT_CONFIG_NOSYSTEM + no global config keeps behaviour independent of the
  // host's git config; a fixed identity keeps commit ids a function of content
  // and time only (no ambient user.name/email).
  const baseEnv = {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "",
    GIT_AUTHOR_NAME: "Secant",
    GIT_AUTHOR_EMAIL: "secant@localhost",
    GIT_COMMITTER_NAME: "Secant",
    GIT_COMMITTER_EMAIL: "secant@localhost",
  } as NodeJS.ProcessEnv;

  /** Run `git`, returning stdout bytes. Throws GitUnavailable if the binary is
   *  absent; throws a plain Error on any nonzero exit (a broken invariant). */
  function git(args: string[], input?: Uint8Array, env = baseEnv): Buffer {
    const result = spawnSync("git", args, {
      input: input === undefined ? undefined : Buffer.from(input),
      env,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new GitUnavailable("the `git` executable was not found on PATH");
      }
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `git ${args[0]} failed (${result.status}): ${result.stderr.toString().trim()}`,
      );
    }
    return result.stdout;
  }

  function ensureRepo(): void {
    if (existsSync(join(gitDir, "HEAD"))) return;
    git(["init", "--bare", "--quiet"]);
  }

  return {
    stageCommit(attemptId, required, outputs, at) {
      // A duplicate or unsafe name is an internal producer bug, not a caller
      // Problem: it would make `git mktree` see two entries at one path (behaviour
      // undefined across git versions), so refuse it loudly like a broken invariant.
      const byName = new Map<string, StageOutput>();
      for (const output of outputs) {
        if (!SAFE_NAME.test(output.name)) {
          throw new Error(`Artifact: unsafe artifact name "${output.name}".`);
        }
        if (byName.has(output.name)) {
          throw new Error(`Artifact: duplicate output name "${output.name}".`);
        }
        byName.set(output.name, output);
      }
      // Refuse before touching git: a required output absent (or present with the
      // wrong type) is named as a Problem, and nothing is committed for this Attempt.
      for (const need of required) {
        const got = byName.get(need.name);
        if (got === undefined || got.type !== need.type) {
          return {
            ok: false,
            problem: { kind: "missing-output", name: need.name },
          };
        }
      }
      try {
        ensureRepo();
        // A fixed date makes GIT_*_DATE explicit rather than "now", so commit ids
        // depend only on content and the Attempt time.
        const date = `${Math.floor(at.getTime() / 1000)} +0000`;
        const env = {
          ...baseEnv,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        };
        const lines: string[] = [];
        for (const output of outputs) {
          const blob = git(["hash-object", "-w", "--stdin"], output.content)
            .toString()
            .trim();
          lines.push(`100644 blob ${blob}\t${output.name}`);
        }
        // ponytail: flat tree, one blob per artifact name. file-set (multiple
        // files under one name) is deferred until a producer emits one — model it
        // as a nested subtree (mktree per subtree) when that lands.
        const tree = git(
          ["mktree"],
          new TextEncoder().encode(lines.join("\n") + "\n"),
        )
          .toString()
          .trim();
        const commit = git(
          ["commit-tree", tree, "-m", `publication ${attemptId}`],
          undefined,
          env,
        )
          .toString()
          .trim();
        // Keep every version reachable so a future `git gc` never prunes it; the
        // commit id doubles as the ref name since it is unique.
        git(["update-ref", `refs/secant/publications/${commit}`, commit]);
        return { ok: true, versionId: commit };
      } catch (error) {
        if (error instanceof GitUnavailable) {
          return {
            ok: false,
            problem: { kind: "git-unavailable", detail: error.message },
          };
        }
        throw error;
      }
    },
    read(versionId, name) {
      if (!SAFE_NAME.test(name)) return undefined;
      const result = spawnSync(
        "git",
        ["cat-file", "blob", `${versionId}:${name}`],
        {
          env: baseEnv,
          maxBuffer: 256 * 1024 * 1024,
        },
      );
      if (result.error) {
        // git absent (or otherwise unspawnable) is an environment fault — distinct
        // from a nonzero exit, which is git saying the path/version is absent.
        if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new GitUnavailable(
            "the `git` executable was not found on PATH",
          );
        }
        throw result.error;
      }
      // A nonzero exit means git ran and the tree-ish or path is absent.
      if (result.status !== 0) return undefined;
      return result.stdout;
    },
  };
}
