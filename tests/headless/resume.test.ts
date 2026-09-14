import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  ensureRuntimeOnPath,
  hostPlatform,
  RUNTIME_NAME,
} from "../helpers/commandBundle.js";
import { openHeadlessHarness } from "../helpers/headlessHarness.js";
import { makeTempDir } from "../helpers/tempDir.js";

// #86 through a real child process on every OS (AC1, AC4, AC5, AC6): a Secant
// process is killed mid-Attempt, the home is reopened, and startup recovery rests
// the Run `halted` with the interrupted Attempt `indeterminate` — running no Step
// work — after which `run resume` continues from that Step to completion with no
// earlier Step re-run. Killing (not cancelling) is the whole point (ADR 0019).

ensureRuntimeOnPath();

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(path: string, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (existsSync(path)) return true;
    await sleep(50);
  }
  return false;
}

/** A three-Step Command Bundle for recovery: `first` appends one line to a marker
 *  (so a re-run is visible as a second line); `block` writes a `started` marker
 *  then sleeps until killed — unless a `proceed` marker exists, when it exits at
 *  once (so a resume completes without sleeping); `last` writes a marker proving
 *  the Run reached the end. Every command names the runtime by bare name, so it
 *  runs on every OS the tests do. */
function writeRecoveryBundle(markers: {
  first: string;
  started: string;
  proceed: string;
  last: string;
}): string {
  const q = (value: string) => JSON.stringify(value);
  const routing = [
    {
      id: "first",
      kind: "command",
      produces: [{ name: "t1", type: "text" }],
      command: {
        executable: RUNTIME_NAME,
        arguments: [
          "-e",
          `require('node:fs').appendFileSync(${q(markers.first)}, 'ran\\n')`,
        ],
      },
    },
    {
      id: "block",
      kind: "command",
      produces: [{ name: "t2", type: "text" }],
      command: {
        executable: RUNTIME_NAME,
        arguments: [
          "-e",
          // Write this process's own pid to the started marker, so the test can
          // kill this grandchild directly after killing the launch process — no
          // long-lived orphan lingers stealing a CPU core (the Windows CI slowdown).
          `const fs=require('node:fs');` +
            `fs.writeFileSync(${q(markers.started)}, String(process.pid));` +
            `if(fs.existsSync(${q(markers.proceed)}))process.exit(0);` +
            `setTimeout(()=>process.exit(0), 30000);`,
        ],
      },
    },
    {
      id: "last",
      kind: "command",
      produces: [{ name: "t3", type: "text" }],
      command: {
        executable: RUNTIME_NAME,
        arguments: [
          "-e",
          `require('node:fs').writeFileSync(${q(markers.last)}, 'ran')`,
        ],
      },
    },
  ];
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.recovery",
      version: "1.0.0",
      name: "Recovery",
      description: "A recovery test Bundle.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [],
    routing,
  };
  const folder = makeTempDir("secant-recovery-bundle-");
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return folder;
}

test(
  "a real Secant process killed mid-Attempt reopens halted+indeterminate; resume finishes with no earlier Step re-run (#86, AC1/AC4/AC5/AC6)",
  { timeout: 60000 },
  async (t: TestContext) => {
    const home = makeTempDir("secant-recovery-home-");
    const workspace = realpathSync.native(makeTempDir("secant-recovery-ws-"));
    const markerDir = makeTempDir("secant-recovery-markers-");
    const markers = {
      first: join(markerDir, "first.log"),
      started: join(markerDir, "started"),
      proceed: join(markerDir, "proceed"),
      last: join(markerDir, "last"),
    };
    const bundleFolder = writeRecoveryBundle(markers);

    // In-process setup over the same home the child will use: build, approve, and
    // read the installed digest, then close the handles before the child launches
    // under the same home (autoClose off so the close happens before the spawn).
    let digest: string;
    {
      const h = openHeadlessHarness(t, {
        slug: "secant-recovery",
        home,
        workspace,
        hostPlatform: hostPlatform(),
        autoClose: false,
      });
      assert.equal(await h.run(["bundle", "build", bundleFolder]), 0);
      const entry = h.catalog
        .listEntries()
        .find((e) => e.id === "dev.secant.recovery");
      assert.ok(entry, h.output());
      h.catalog.approveWorkspace(workspace, new Date());
      digest = entry.digest;
      h.close();
    }

    // A real child process launches the Run and blocks in the `block` Step's sleep.
    const child = spawn(
      process.execPath,
      [CLI, "run", "launch", "dev.secant.recovery", "--trust", digest],
      { cwd: workspace, env: { ...process.env, SECANT_HOME: home } },
    );
    const childErr: string[] = [];
    child.stderr.on("data", (d: Buffer) => childErr.push(d.toString()));
    child.stdout.on("data", () => {});
    const exited = new Promise<void>((resolve) =>
      child.on("exit", () => resolve()),
    );

    const started = await waitForFile(markers.started, 20000);
    assert.ok(
      started,
      `child never reached the block Step: ${childErr.join("")}`,
    );

    // Kill the process mid-Attempt (never a cancel): SIGKILL is uncatchable, so the
    // Run is left `running` with a live claim, exactly like a crash.
    child.kill("SIGKILL");
    await exited;
    // Killing the launch process orphans the grandchild command (still sleeping);
    // kill it directly by the pid it wrote, so it never lingers stealing a CPU core.
    const blockPid = Number(readFileSync(markers.started, "utf8").trim());
    if (Number.isInteger(blockPid) && blockPid > 0) {
      try {
        process.kill(blockPid, "SIGKILL");
      } catch {
        // Already gone — nothing to clean up.
      }
    }

    // Reopen the home in-process: startup recovery reconciles the killed Run.
    const h = openHeadlessHarness(t, {
      slug: "secant-recovery",
      home,
      workspace,
      hostPlatform: hostPlatform(),
    });
    const group = h.runGroup!;

    const listed = group.listRuns();
    assert.equal(listed.length, 1);
    const runId = listed[0]!.runId;
    const owner = group.acquireRun(runId);
    assert.ok(owner);
    const read = group.readRun(runId);
    assert.ok(read.ok);
    assert.equal(read.run.state, "halted");
    assert.equal(owner.attemptLog().at(-1)?.outcome, "indeterminate");
    owner.close();

    // Recovery ran no Step work: `first` ran exactly once (at launch), `last` never
    // ran (the side-effect that must not appear — AC4).
    assert.equal(readFileSync(markers.first, "utf8"), "ran\n");
    assert.equal(existsSync(markers.last), false);

    // Let the interrupted Step complete instantly on resume, then resume in-process.
    writeFileSync(markers.proceed, "go");
    h.reset();
    assert.equal(await h.run(["run", "resume", runId]), 0);
    // Match against combined stdout+stderr, as the pre-harness capture did.
    assert.match(h.output(), /^State: succeeded$/m);

    // The earlier Step was not re-run (still one line); the final Step ran on resume.
    assert.equal(readFileSync(markers.first, "utf8"), "ran\n");
    assert.equal(existsSync(markers.last), true);
  },
);
