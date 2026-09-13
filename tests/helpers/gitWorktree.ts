import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./tempDir.js";

// Real temporary Git worktrees for the Preflight git-worktree-root probe tests
// (testing.md: use real deterministic local resources, not mocks). The hardened
// env keeps every repo independent of the host's Git config and gives commits a
// fixed identity, mirroring src/run/store/artifacts/artifacts.ts.

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "",
  GIT_AUTHOR_NAME: "Secant",
  GIT_AUTHOR_EMAIL: "secant@localhost",
  GIT_COMMITTER_NAME: "Secant",
  GIT_COMMITTER_EMAIL: "secant@localhost",
} as NodeJS.ProcessEnv;

/** Run `git` in `cwd`; throw on any non-zero exit so a broken fixture fails loud. */
export function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function commit(cwd: string): void {
  writeFileSync(join(cwd, "seed.txt"), "seed\n");
  git(cwd, "add", "seed.txt");
  git(cwd, "commit", "--message", "seed");
}

/** A classic worktree root with one commit. */
export function classicWorktree(): string {
  const dir = realpathSync.native(makeTempDir("secant-git-classic-"));
  git(dir, "init", "--quiet");
  commit(dir);
  return dir;
}

/** An unborn worktree root: `git init` with no commit yet — still qualifies. */
export function unbornWorktree(): string {
  const dir = realpathSync.native(makeTempDir("secant-git-unborn-"));
  git(dir, "init", "--quiet");
  return dir;
}

/** A linked worktree root created with `git worktree add` — still qualifies. The
 *  linked path is a fresh, not-yet-existing subdir (git creates it). */
export function linkedWorktree(): string {
  const main = classicWorktree();
  const linked = join(makeTempDir("secant-git-linkedbase-"), "linked");
  git(main, "worktree", "add", linked);
  return realpathSync.native(linked);
}

/** A bare repository directory: has no working tree, so it does NOT qualify. */
export function bareRepo(): string {
  const dir = realpathSync.native(makeTempDir("secant-git-bare-"));
  git(dir, "init", "--bare", "--quiet");
  return dir;
}

/** A plain directory that is not a Git repository at all. */
export function plainDirectory(): string {
  return realpathSync.native(makeTempDir("secant-git-plain-"));
}
