// The canonical test launcher. It runs Bun's test runner with two isolated file
// workers on Windows, but ONE on macOS and Linux (`--parallel=1`), because of a
// Bun 1.4.2 defect — not a preference.
//
// The defect (#149): on a CPU-constrained CI runner — first the macOS arm64 runner
// (3 vCPUs), then the ubuntu-latest runner (#150) — when
// two isolated workers start and each spawns a child process at the same time, Bun
// occasionally fails to wire up a child's lifecycle entirely. The child runs and
// exits — Bun even populates `child.exitCode` — but the `exit` event, the `close`
// event, and all stdout/stderr `data` are silently dropped. `spawnCommand`
// (src/process/process.ts) resolves on `close`, so the Attempt never settles and
// the test hits its 30s timeout. It is always the FIRST spawn in a freshly started,
// starved worker; Bun runs one worker per file (`--isolate`), so any file's first
// spawning test is a candidate, which is why the CI failures were scattered. It is
// not our env-marker handling, not fd inheritance (workers are separate processes;
// the pipes are cloexec), and not `detached` (it reproduces with `detached: false`).
// Bun 1.4.2 is the latest stable, so there is no version to upgrade to.
//
// Two concurrent workers doubling the startup contention are what tip it over.
// Serializing to one worker per file keeps full file isolation (each file still
// runs in its own process — module-level helpers and env changes never leak) but
// removes the concurrent first-spawn window, so the race does not fire on the
// runner. This is a mitigation of a runtime bug, not a cure: enough external CPU
// pressure can still starve even a single worker's first spawn. Revisit — and
// restore `--parallel=2` on macOS and Linux — when Bun fixes child-process
// lifecycle delivery under load. Do NOT "fix" this with a retry, a sleep, or a larger
// timeout (docs/agents/testing.md): those hide the defect instead of avoiding it.
//
// Extra arguments pass through, so `bun run test -- tests/foo.test.ts` still works.
import { spawnSync } from "node:child_process";

const parallel = process.platform === "win32" ? "2" : "1";
const result = spawnSync(
  process.execPath,
  [
    "test",
    `--parallel=${parallel}`,
    "--timeout",
    "30000",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
