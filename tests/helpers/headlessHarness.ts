import { realpathSync } from "node:fs";
import { type TestContext } from "node:test";
import {
  createApplication,
  type RunExecution,
} from "../../src/application/application.js";
import { type HeadlessIO, runHeadless } from "../../src/headless/headless.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { openRunGroup } from "../../src/run/store/store.js";
import type { Platform } from "../../src/workflow/workflow.js";
import { hostPlatform } from "./commandBundle.js";
import { makeTempDir } from "./tempDir.js";

// The one headless CLI harness. It wires an isolated Catalog + Run Store +
// execution + Application over a temporary home and Workspace, drives the CLI
// through `run(argv)`, and captures stdout/stderr — so every headless suite builds
// on this instead of hand-wiring the same four Modules five times.
//
// Two overrides cover the shapes the suites need: `runSupport: false` for the
// Bundle/Workspace-only suite (no Run Store or execution), and `home` + `workspace`
// with `autoClose: false` for the recovery suite, which reopens one shared home
// across a killed child process and must close its handles before the child runs.

export interface HeadlessHarnessOptions {
  /** Temp-dir prefix for the home/store/Workspace this harness creates. */
  readonly slug?: string;
  /** Reuse an existing SECANT_HOME instead of a fresh temp dir (recovery suite). */
  readonly home?: string;
  /** Reuse an existing, already-canonical Workspace path. */
  readonly workspace?: string;
  /** Wire the Run Store + execution (default true); false for Bundle-only suites. */
  readonly runSupport?: boolean;
  /** Register `t.after` cleanup (default true); false when the caller closes by hand. */
  readonly autoClose?: boolean;
  /** Pin the host platform passed into the Application. */
  readonly hostPlatform?: Platform;
  /** Command-Step timeout handed to execution. */
  readonly commandTimeoutMs?: number;
}

export interface HeadlessHarness {
  readonly clients: ReturnType<typeof createApplication>;
  readonly catalog: ReturnType<typeof openCatalog>;
  /** The Run Store, or `undefined` when `runSupport: false`. */
  readonly runGroup: ReturnType<typeof openRunGroup> | undefined;
  readonly workspace: string;
  readonly io: HeadlessIO;
  /** Run the CLI over the captured IO and return its exit code. */
  readonly run: (argv: string[]) => number;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** stdout + stderr, for a combined assertion message. */
  readonly output: () => string;
  readonly reset: () => void;
  /** Close the Catalog and Run Store now (needed only with `autoClose: false`). */
  readonly close: () => void;
}

export function openHeadlessHarness(
  t: TestContext,
  opts: HeadlessHarnessOptions = {},
): HeadlessHarness {
  const slug = opts.slug ?? "secant-headless";
  const runSupport = opts.runSupport ?? true;
  const autoClose = opts.autoClose ?? true;

  const home = opts.home ?? makeTempDir(`${slug}-home-`);
  const catalog = openCatalog(home);
  const workspace =
    opts.workspace ?? realpathSync.native(makeTempDir(`${slug}-ws-`));

  // A shared home keys the Catalog and the Run Store together (recovery reopens
  // one home); otherwise each gets its own isolated temp dir.
  const runGroup = runSupport
    ? openRunGroup(opts.home ?? makeTempDir(`${slug}-store-`), workspace)
    : undefined;

  const close = () => {
    runGroup?.close();
    catalog.close();
  };
  if (autoClose) t.after(close);

  const runExecution: RunExecution = ({ routing, owner }) =>
    executeRouting(routing, {
      owner,
      platform: hostPlatform(),
      resolveAsset: () => undefined,
      ...(opts.commandTimeoutMs !== undefined
        ? { commandTimeoutMs: opts.commandTimeoutMs }
        : {}),
    });

  const clients = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    ...(opts.hostPlatform !== undefined
      ? { hostPlatform: opts.hostPlatform }
      : {}),
    ...(runSupport ? { runGroup, runExecution } : {}),
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
    close,
  };
}
