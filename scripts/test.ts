// The canonical test launcher. It runs Bun's test runner with three isolated file
// workers on every OS.
//
// The enabler is a spawn-free semantic suite, not an upstream Bun fix. Worker
// count was capped for one reason only: a Bun 1.4.2 defect (#149, #150) where two
// isolated workers each spawning a child at startup could make Bun drop that
// child's `exit`/`close`/stdio events entirely, so the spawn never settled and the
// test timed out at 30s. The #172 calibration then rejected three workers on the
// four-logical-processor public Windows runner (run 35507654564) with the same
// symptoms — scattered child-process timeouts, an indeterminate Command attempt, a
// failed Harness schema probe — every one a spawn-lifecycle artifact.
//
// Every suite that reached a real child under the runner has since moved to the
// standalone runtime-conformance runner — the last two, the Claude Code and Codex
// Harness suites, in #198 — so no worker spawns a child at startup and the defect
// can no longer fire. With its only cause removed, the count is raised to three
// (one worker per logical processor on the Windows runner leaves headroom for the
// OS), validated by the three-OS `check` matrix.
//
// Full file isolation stays load-bearing: each file runs in its own worker
// process, so module-level helpers and environment changes never leak across
// files. Tests within each file remain sequential; do NOT replace file parallelism
// with `--concurrent`, which would race their shared fixtures. Should
// child-lifecycle flakiness ever return, the fix is to keep the spawn out of the
// semantic suite, never a retry, a sleep, or a larger timeout (docs/agents/testing.md).
//
// Extra arguments pass through, so `bun run test -- tests/foo.test.ts` still works.
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["test", "--parallel=3", "--timeout", "30000", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
