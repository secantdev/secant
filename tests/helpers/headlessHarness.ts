import { realpathSync } from "node:fs";
import { type TestContext } from "node:test";
import { type RunExecution } from "../../src/application/application.js";
import type { ApplicationHarnessRegistration } from "../../src/application/application.js";
import { type HeadlessIO, runHeadless } from "../../src/headless/headless.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import { createApplication } from "./application.js";
import { openFakeRunGroup as openRunGroup } from "../run/store/fake-git-process.js";
import { createFakeBundleProcess } from "./fakeBundleProcess.js";
import type { Platform } from "../../src/workflow/workflow.js";
import { hostPlatform } from "./commandBundle.js";
import { makeTempDir } from "./tempDir.js";

// The one headless CLI harness. It wires an isolated Catalog + Run Store +
// execution + Application over a temporary home and Workspace, drives the CLI
// through `run(argv)`, and captures stdout/stderr — so every headless suite builds
// on this instead of hand-wiring the same four Modules five times.
//
// It runs process-free: command execution goes through the shared Process double
// (`createFakeBundleProcess`, which interprets the authoring helpers' `-e` scripts)
// and the Run Store's artifact Git through the fake Git — the compiled-binary smoke
// is the only place headless runs a real child. Suites that need a bespoke Process
// pass their own through `process`.
//
// `runSupport: false` covers the Bundle/Workspace-only suite (no Run Store or
// execution); every other suite takes the defaults.

export interface HeadlessHarnessOptions {
  /** Temp-dir prefix for the home/store/Workspace this harness creates. */
  readonly slug?: string;
  /** Wire the Run Store + execution (default true); false for Bundle-only suites. */
  readonly runSupport?: boolean;
  /** Pin the host platform passed into the Application. */
  readonly hostPlatform?: Platform;
  /** Command-Step timeout handed to execution. */
  readonly commandTimeoutMs?: number;
  /** Override the Process double (default: the shared bundle-command fake). */
  readonly process?: ProcessAdapter;
  /** Literal normalized Harness registrations for catalog/selection tests. */
  readonly harnessRegistry?: readonly ApplicationHarnessRegistration[];
  /** Application clock for deterministic Projection evidence. */
  readonly now?: () => Date;
}

export interface HeadlessHarness {
  readonly clients: ReturnType<typeof createApplication>;
  readonly catalog: ReturnType<typeof openCatalog>;
  /** The Run Store, or `undefined` when `runSupport: false`. */
  readonly runGroup: ReturnType<typeof openRunGroup> | undefined;
  readonly workspace: string;
  readonly io: HeadlessIO;
  /** Run the CLI over the captured IO and return its exit code. Async because a
   *  Run command settles asynchronously (execution spawns). */
  readonly run: (argv: string[]) => Promise<number>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** stdout + stderr, for a combined assertion message. */
  readonly output: () => string;
  readonly reset: () => void;
}

export function openHeadlessHarness(
  t: TestContext,
  opts: HeadlessHarnessOptions = {},
): HeadlessHarness {
  const slug = opts.slug ?? "secant-headless";
  const runSupport = opts.runSupport ?? true;
  const executionProcess = opts.process ?? createFakeBundleProcess();

  const catalog = openCatalog(makeTempDir(`${slug}-home-`));
  const workspace = realpathSync.native(makeTempDir(`${slug}-ws-`));

  const runGroup = runSupport
    ? openRunGroup(makeTempDir(`${slug}-store-`), workspace)
    : undefined;

  t.after(() => {
    runGroup?.close();
    catalog.close();
  });

  const runExecution: RunExecution = ({ routing, owner }) =>
    executeRouting(routing, {
      owner,
      platform: hostPlatform(),
      resolveAsset: () => undefined,
      process: executionProcess,
      ...(opts.commandTimeoutMs !== undefined
        ? { commandTimeoutMs: opts.commandTimeoutMs }
        : {}),
    });

  const clients = createApplication({
    catalog,
    process: executionProcess,
    launchWorkspacePath: workspace,
    ...(opts.hostPlatform !== undefined
      ? { hostPlatform: opts.hostPlatform }
      : {}),
    ...(runSupport ? { runGroup, runExecution } : {}),
    ...(opts.harnessRegistry !== undefined
      ? { harnessRegistry: opts.harnessRegistry }
      : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: () => workspace,
  };

  return {
    clients,
    catalog,
    runGroup,
    workspace,
    io,
    run: (argv) => runHeadless(clients, argv, io),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    output: () => out.join("") + err.join(""),
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}
