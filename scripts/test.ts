// The canonical test launcher: Bun's test runner with four isolated file workers
// on every OS (`--parallel=4`).
//
// Raising the worker count is safe because the semantic suite is spawn-free: every
// suite that reached a real child under the runner moved to standalone runtime
// conformance (the last two, the Claude Code and Codex Harness suites, in #198),
// so the Bun 1.4.2 child-lifecycle defect (#149, #150) — and the #172 three-worker
// rejection it caused on the Windows runner — can no longer fire.
//
// The count is tuned by the split-out per-step CI timing (check.yml): the `bun
// test` step is execution-bound on the Windows runner (the tests are I/O-heavy —
// temp dirs, per-test SQLite — and run ~10x slower there than on Linux/macOS), and
// that work parallelizes, so workers are set to the Windows runner's four logical
// processors. Raise further only while the Windows `Test` step keeps dropping; a
// green three-OS `check` matrix validates each count.
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
  ["test", "--parallel=4", "--timeout", "30000", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
