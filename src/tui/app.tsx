import { TextAttributes } from "@opentui/core";
import {
  createEffect,
  createSignal,
  ErrorBoundary,
  For,
  Match,
  onMount,
  Switch,
  type ParentProps,
} from "solid-js";
import { ApprovalDialog } from "./approval-dialog.js";
import { BundleCatalog } from "./bundle-catalog.js";
import {
  BundleCatalogViewProvider,
  type BundleCatalogView,
} from "./bundle-view.js";
import {
  HarnessCatalogViewProvider,
  type HarnessCatalogView,
} from "./harness-view.js";
import { Home } from "./home.js";
import { HarnessCatalog } from "./harness-catalog.js";
import { createTuiKeymap, KeymapProvider, useBindings } from "./keymap.js";
import {
  LaunchPreparationViewProvider,
  type LaunchPreparationView,
} from "./launch-preparation-view.js";
import { PreviousRuns } from "./previous-runs.js";
import type { RendererPort } from "./renderer/renderer.js";
import {
  RunActionsViewProvider,
  type RunActionsView,
} from "./run-actions-view.js";
import {
  RunListViewProvider,
  useRunListView,
  type RunListView,
} from "./run-list-view.js";
import { RunWorkbench } from "./run-workbench.js";
import { RunWorkbenchViewProvider, type RunWorkbenchView } from "./run-view.js";
import { StartRun } from "./start-run.js";
import {
  RunLaunchViewProvider,
  type RunLaunchView,
} from "./run-launch-view.js";
import { DialogProvider, useDialog } from "./vendor/dialog.js";
import { useExit, type Exit, ExitProvider } from "./vendor/exit.js";
import { ThemeProvider, useTheme } from "./vendor/theme-context.js";
import {
  useWorkspaceView,
  WorkspaceViewProvider,
  type WorkspaceView,
} from "./workspace-view.js";

// The application root. The approval dialog overlays Home through the vendored
// dialog primitive while the launch Workspace is unapproved; approving flips the
// snapshot and clears it. Once approved, a small screen signal navigates Home →
// the task screens and read-only catalogs: exactly one screen mounts at a time,
// so each screen's key bindings exist only while it is active and cannot conflict.
// Catalog selection lives here so a Home round-trip restores the same row. The
// Previous Runs list (#92) works the same way, and a Run opened
// from it records that origin so Escape (and a delete) returns to the list, while
// a Run opened from Start a Run returns to Home.

type Screen =
  | { readonly name: "home" }
  | { readonly name: "start-run" }
  | { readonly name: "bundle-catalog" }
  | { readonly name: "harness-catalog" }
  | { readonly name: "previous-runs" }
  | {
      readonly name: "run-workbench";
      readonly runId: string;
      readonly knownBundleName?: string;
      readonly from: "start-run" | "previous-runs";
    };

function Route(props: { renderer: RendererPort }) {
  const view = useWorkspaceView();
  const dialog = useDialog();
  const exit = useExit();
  const approved = () => view.snapshot().approval.state === "approved";

  const [screen, setScreen] = createSignal<Screen>({ name: "home" });
  const [homeSelected, setHomeSelected] = createSignal(0);
  const [selected, setSelected] = createSignal(0);
  const [harnessSelected, setHarnessSelected] = createSignal(0);
  // The Previous Runs list's selected row, kept here so Escape from a Run restores
  // it (like the Bundle catalog's `selected`).
  const [runSelected, setRunSelected] = createSignal(0);
  const [deletedRunNotice, setDeletedRunNotice] = createSignal<string>();
  // The same narrowing for the Workbench, so its Run id reaches the child typed.
  const watching = () => {
    const current = screen();
    return current.name === "run-workbench" ? current : undefined;
  };

  // Open the approval dialog exactly once, at mount, when the launch Workspace
  // is unapproved. It is not re-opened when the stack empties: dismissing it
  // (Escape, Ctrl+C, or Decline) declines and exits, and re-pushing then would
  // race the teardown. Approval is the only other way it closes, handled below.
  const [approvalOpen, setApprovalOpen] = createSignal(false);
  onMount(() => {
    if (!approved()) {
      setApprovalOpen(true);
      dialog.replace(
        () => <ApprovalDialog />,
        // The dialog's onClose fires on any removal — a user dismissal (Escape /
        // Ctrl+C) but also the programmatic `dialog.clear()` below once approval
        // lands. Only the former is a decline: guard on `approved()` so clearing
        // an approved Workspace's dialog never exits `declined`.
        () => {
          if (!approved()) exit("declined");
        },
      );
    }
  });

  // When approval lands, clear the approval dialog so Home becomes interactive.
  // One-shot, guarded on `approvalOpen`: a later dialog pushed while already
  // approved — the quit confirmation — must not be cleared by this effect.
  createEffect(() => {
    if (approved() && approvalOpen()) {
      setApprovalOpen(false);
      dialog.clear();
    }
  });

  return (
    <Switch
      fallback={
        <Home
          selected={homeSelected}
          setSelected={setHomeSelected}
          onStartRun={() => setScreen({ name: "start-run" })}
          onOpenBundles={() => setScreen({ name: "bundle-catalog" })}
          onOpenPreviousRuns={() => setScreen({ name: "previous-runs" })}
          onOpenHarnesses={() => setScreen({ name: "harness-catalog" })}
        />
      }
    >
      <Match when={screen().name === "start-run"}>
        <StartRun
          onLeave={() => setScreen({ name: "home" })}
          onStarted={(runId, bundleName) =>
            setScreen({
              name: "run-workbench",
              runId,
              knownBundleName: bundleName,
              from: "start-run",
            })
          }
        />
      </Match>
      <Match when={watching()}>
        {(active) => {
          // Escape restores the originating screen. Deletion always returns to
          // Previous Runs, where the durable list can explain the missing subject.
          const back = () =>
            setScreen(
              active().from === "previous-runs"
                ? { name: "previous-runs" }
                : { name: "home" },
            );
          return (
            <RunWorkbench
              runId={active().runId}
              knownBundleName={active().knownBundleName}
              renderer={props.renderer}
              onLeave={back}
              onDeleted={(name) => {
                setDeletedRunNotice(`${name} was deleted`);
                setScreen({ name: "previous-runs" });
              }}
            />
          );
        }}
      </Match>
      <Match when={screen().name === "previous-runs"}>
        <PreviousRuns
          selected={runSelected}
          setSelected={setRunSelected}
          notice={deletedRunNotice}
          onDismissNotice={() => setDeletedRunNotice(undefined)}
          onOpen={(runId, bundleName) =>
            setScreen({
              name: "run-workbench",
              runId,
              knownBundleName: bundleName,
              from: "previous-runs",
            })
          }
          onBack={() => setScreen({ name: "home" })}
        />
      </Match>
      <Match when={screen().name === "bundle-catalog"}>
        <BundleCatalog
          selected={selected}
          setSelected={setSelected}
          onBack={() => setScreen({ name: "home" })}
        />
      </Match>
      <Match when={screen().name === "harness-catalog"}>
        <HarnessCatalog
          selected={harnessSelected}
          setSelected={setHarnessSelected}
          onBack={() => setScreen({ name: "home" })}
        />
      </Match>
    </Switch>
  );
}

function Fallback(props: { error: unknown; exit: Exit }) {
  const { theme } = useTheme();
  // A render failure is an exit path: surface it, then ask the composition root
  // to tear down and print it to the restored terminal.
  props.exit(props.error);
  return (
    <text fg={theme.error}>
      {props.error instanceof Error ? props.error.message : String(props.error)}
    </text>
  );
}

// The quit confirmation content, rendered through the vendored dialog primitive
// (the backdrop and centred panel come from `Dialog`, as the approval dialog).
// Living on the dialog stack is what makes it modal: every screen's key bindings
// are gated on `dialog.stack.length === 0`, so while this is up none of them fire
// alongside its own. `q` with any live Run this instance owns opens it once;
// Return on the default "Keep Running" — like Escape / Ctrl+C, which the dialog
// primitive dismisses — leaves every Run running, while "Halt and Quit" takes the
// shared exit path, which drains (aborts and rests) every live Run through the
// same drain SIGINT uses.
function QuitConfirmation(props: {
  liveRunCount: number;
  onKeepRunning: () => void;
  onHaltAndQuit: () => void;
}) {
  const { theme } = useTheme();
  const [choice, setChoice] = createSignal<"keep" | "quit">("keep");
  const toggle = () =>
    setChoice((current) => (current === "keep" ? "quit" : "keep"));
  const choose = (option: "keep" | "quit") =>
    option === "quit" ? props.onHaltAndQuit() : props.onKeepRunning();
  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Choose",
        group: "Quit",
        cmd: () => choose(choice()),
      },
      { key: "left", desc: "Previous option", group: "Quit", cmd: toggle },
      { key: "right", desc: "Next option", group: "Quit", cmd: toggle },
      { key: "tab", desc: "Next option", group: "Quit", cmd: toggle },
    ],
  }));
  const noun = props.liveRunCount === 1 ? "Run" : "Runs";
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        {`Halt ${props.liveRunCount} live ${noun} and quit?`}
      </text>
      <text fg={theme.textMuted} paddingBottom={1}>
        All live Runs in this Secant instance will rest halted.
      </text>
      <box
        flexDirection="row"
        justifyContent="flex-end"
        gap={1}
        paddingBottom={1}
      >
        <For each={["keep", "quit"] as const}>
          {(option) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={choice() === option ? theme.primary : undefined}
              onMouseUp={() => choose(option)}
            >
              <text
                fg={
                  choice() === option
                    ? theme.selectedListItemText
                    : theme.textMuted
                }
              >
                {(choice() === option ? "› " : "  ") +
                  (option === "quit" ? "Halt and Quit" : "Keep Running")}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  );
}

function GuardedExitProvider(props: ParentProps<{ exit: Exit }>) {
  const dialog = useDialog();
  const runs = useRunListView().openRunList();
  const exit: Exit = (reason) => {
    // Only the plain quit binding is guarded; a reason (a decline or a render
    // failure) exits at once, without draining or confirming.
    if (reason !== undefined) {
      props.exit(reason);
      return;
    }
    // Read the whole Previous Runs list, then count the Runs live in this
    // instance. Launch never gates on other live Runs (ADR 0031), so this count
    // is consulted only here, at quit: with none live, quit at once; otherwise
    // one confirmation naming the count, then the shared drain.
    while (runs.state().hasMore) runs.loadMore();
    const count = runs
      .state()
      .rows.filter((row) => row.live && row.ownedByThisProcess).length;
    if (count === 0) {
      props.exit();
      return;
    }
    dialog.replace(() => (
      <QuitConfirmation
        liveRunCount={count}
        onKeepRunning={() => dialog.clear()}
        onHaltAndQuit={() => props.exit()}
      />
    ));
  };
  return <ExitProvider exit={exit}>{props.children}</ExitProvider>;
}

export function App(props: {
  view: WorkspaceView;
  bundles: BundleCatalogView;
  harnesses: HarnessCatalogView;
  preparation: LaunchPreparationView;
  launch: RunLaunchView;
  run: RunWorkbenchView;
  /** The Previous Runs read seam and the Run Actions submit seam (#92). Required:
   *  production (`mount.tsx`) always passes the live seams and a test that never
   *  reaches those screens passes an inert fake (A28) — a shallow production stub
   *  reachable only from tests no longer earns its keep. */
  runList: RunListView;
  actions: RunActionsView;
  renderer: RendererPort;
  exit: Exit;
}) {
  const keymap = createTuiKeymap();
  return (
    <ExitProvider exit={props.exit}>
      <ThemeProvider>
        <KeymapProvider keymap={keymap}>
          <WorkspaceViewProvider view={props.view}>
            <BundleCatalogViewProvider view={props.bundles}>
              <HarnessCatalogViewProvider view={props.harnesses}>
                <LaunchPreparationViewProvider view={props.preparation}>
                  <RunLaunchViewProvider view={props.launch}>
                    <RunWorkbenchViewProvider view={props.run}>
                      <RunListViewProvider view={props.runList}>
                        <RunActionsViewProvider view={props.actions}>
                          <DialogProvider>
                            <GuardedExitProvider exit={props.exit}>
                              <ErrorBoundary
                                fallback={(error) => (
                                  <Fallback error={error} exit={props.exit} />
                                )}
                              >
                                <Route renderer={props.renderer} />
                              </ErrorBoundary>
                            </GuardedExitProvider>
                          </DialogProvider>
                        </RunActionsViewProvider>
                      </RunListViewProvider>
                    </RunWorkbenchViewProvider>
                  </RunLaunchViewProvider>
                </LaunchPreparationViewProvider>
              </HarnessCatalogViewProvider>
            </BundleCatalogViewProvider>
          </WorkspaceViewProvider>
        </KeymapProvider>
      </ThemeProvider>
    </ExitProvider>
  );
}
