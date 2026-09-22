// The canonical test launcher: Bun's test runner with three isolated file workers
// on every OS (`--parallel=3`).
//
// Raising the worker count is safe because the semantic suite is spawn-free: every
// suite that reached a real child under the runner moved to standalone runtime
// conformance (the last two, the Claude Code and Codex Harness suites, in #198),
// so the Bun 1.4.2 child-lifecycle defect (#149, #150) — and the #172 three-worker
// rejection it caused on the Windows runner — can no longer fire.
//
// Three is where worker count stops paying off, measured on the split-out per-step
// CI timing (check.yml). The `bun test` step is slow only on the Windows runner
// (~190s vs ~20s on Linux/macOS) and is I/O-bound, not CPU-bound: the tests each
// open a temp dir and a per-test SQLite database, and the workers contend on the
// runner's disk rather than overlapping, so effective parallelism plateaus near
// three. Raising to four was measured and moved the Windows `Test` step by ~0s, so
// the count is held at three. The remaining Windows cost is the tests' own disk
// I/O; no worker count reduces it.
//
// File isolation stays load-bearing: each file runs in its own worker, so
// module-level helpers and environment changes never leak across files. Tests
// within a file remain sequential; do NOT use `--concurrent`, which would race
// their shared fixtures. Child-lifecycle flakiness is fixed by keeping spawns out
// of the semantic suite, never a retry, a sleep, or a larger timeout
// (docs/agents/testing.md).
//
// Extra arguments pass through, so `bun run test -- tests/foo.test.ts` still works.
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["test", "--parallel=3", "--timeout", "30000", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
