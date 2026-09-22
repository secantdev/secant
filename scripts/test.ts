// The canonical test launcher. It runs Bun's test runner with two isolated file
// workers on every OS.
//
// The enabler is a spawn-free semantic suite, not an upstream Bun fix. The
// serialization this replaces worked around a Bun 1.4.2 defect (#149, #150): on a
// CPU-constrained CI runner, two isolated workers each spawning a child at
// startup could make Bun drop that child's `exit`/`close`/stdio events entirely,
// so the spawn never settled and the test timed out at 30s. Every suite that
// reached a real child under the runner has since moved to the standalone
// runtime-conformance runner — the last two, the Claude Code and Codex Harness
// suites, in #198 — so no worker spawns a child at startup and the defect can no
// longer fire. Bun 1.4.2 is unchanged; the race is avoided by removing the spawn,
// not by a runtime fix.
//
// Two is the highest worker count validated on the four-logical-processor public
// Windows runner (issue #172, run 35507654564); macOS and Linux match it. Full
// file isolation stays load-bearing: each file runs in its own worker process, so
// module-level helpers and environment changes never leak across files. Tests
// within each file remain sequential; do NOT replace file parallelism with
// `--concurrent`, which would race their shared fixtures. Should child-lifecycle
// flakiness ever return, the fix is to keep the spawn out of the semantic suite,
// never a retry, a sleep, or a larger timeout (docs/agents/testing.md).
//
// Extra arguments pass through, so `bun run test -- tests/foo.test.ts` still works.
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["test", "--parallel=2", "--timeout", "30000", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
