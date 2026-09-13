import {
  createEffect,
  createSignal,
  ErrorBoundary,
  Match,
  onMount,
  Switch,
} from "solid-js";
import type { BundleFocusSelector } from "../application/projection-port.js";
import { ApprovalDialog } from "./approval-dialog.js";
import { BundleInspect } from "./bundle-inspect.js";
import { BundleList } from "./bundle-list.js";
import {
  BundleCatalogViewProvider,
  type BundleCatalogView,
} from "./bundle-view.js";
import { Home } from "./home.js";
import { createTuiKeymap, KeymapProvider } from "./keymap.js";
import { PreviousRuns } from "./previous-runs.js";
import type { RendererPort } from "./renderer/renderer.js";
import {
  RunActionsViewProvider,
  type RunActionsView,
} from "./run-actions-view.js";
import { RunListViewProvider, type RunListView } from "./run-list-view.js";
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
// Bundle list → Bundle inspection: exactly one screen mounts at a time, so each
// screen's key bindings exist only while it is active and cannot conflict. The
// list's selected index lives here so Escape from inspection restores the same
// row (#57). The Previous Runs list (#92) works the same way, and a Run opened
// from it records that origin so Escape (and a delete) returns to the list, while
// a Run opened from Start a Run returns to Home.

type Screen =
  | { readonly name: "home" }
  | { readonly name: "start-run" }
  | { readonly name: "bundle-list" }
  | { readonly name: "bundle-inspect"; readonly selector: BundleFocusSelector }
  | { readonly name: "previous-runs" }
  | {
      readonly name: "run-workbench";
      readonly runId: string;
      readonly from: "start-run" | "previous-runs";
    };

function Route(props: { renderer: RendererPort }) {
  const view = useWorkspaceView();
  const dialog = useDialog();
  const exit = useExit();
  const approved = () => view.snapshot().approval.state === "approved";

  const [screen, setScreen] = createSignal<Screen>({ name: "home" });
  const [selected, setSelected] = createSignal(0);
  // The Previous Runs list's selected row, kept here so Escape from a Run restores
  // it (like the Bundle list's `selected`).
  const [runSelected, setRunSelected] = createSignal(0);
  // Narrow the union to the inspect variant so its `selector` reaches the child
  // typed, with no `as` cast: the accessor is undefined for every other screen.
  const inspecting = () => {
    const current = screen();
    return current.name === "bundle-inspect" ? current : undefined;
  };
  // The same narrowing for the Workbench, so its Run id reaches the child typed.
  const watching = () => {
    const current = screen();
    return current.name === "run-workbench" ? current : undefined;
  };

  // Open the approval dialog exactly once, at mount, when the launch Workspace
  // is unapproved. It is not re-opened when the stack empties: dismissing it
  // (Escape, Ctrl+C, or Decline) declines and exits, and re-pushing then would
  // race the teardown. Approval is the only other way it closes, handled below.
  onMount(() => {
    if (!approved()) {
      dialog.replace(
        () => <ApprovalDialog />,
        () => exit("declined"),
      );
    }
  });

  // When approval lands, clear the dialog so Home becomes interactive.
  createEffect(() => {
    if (approved() && dialog.stack.length > 0) dialog.clear();
  });

  return (
    <Switch
      fallback={
        <Home
          onStartRun={() => setScreen({ name: "start-run" })}
          onOpenBundles={() => setScreen({ name: "bundle-list" })}
          onOpenPreviousRuns={() => setScreen({ name: "previous-runs" })}
        />
      }
    >
      <Match when={screen().name === "start-run"}>
        <StartRun
          onLeave={() => setScreen({ name: "home" })}
          onStarted={(runId) =>
            setScreen({ name: "run-workbench", runId, from: "start-run" })
          }
        />
      </Match>
      <Match when={watching()}>
        {(active) => {
          // A Run opened from the Previous Runs list returns there on Escape and
          // on delete; one from Start a Run returns to Home.
          const back = () =>
            setScreen(
              active().from === "previous-runs"
                ? { name: "previous-runs" }
                : { name: "home" },
            );
          return (
            <RunWorkbench
              runId={active().runId}
              renderer={props.renderer}
              onLeave={back}
              onDeleted={back}
            />
          );
        }}
      </Match>
      <Match when={screen().name === "previous-runs"}>
        <PreviousRuns
          selected={runSelected}
          setSelected={setRunSelected}
          onOpen={(runId) =>
            setScreen({ name: "run-workbench", runId, from: "previous-runs" })
          }
          onBack={() => setScreen({ name: "home" })}
        />
      </Match>
      <Match when={screen().name === "bundle-list"}>
        <BundleList
          selected={selected}
          setSelected={setSelected}
          onOpen={(selector) => setScreen({ name: "bundle-inspect", selector })}
          onBack={() => setScreen({ name: "home" })}
        />
      </Match>
      <Match when={inspecting()}>
        {(active) => (
          <BundleInspect
            selector={active().selector}
            onBack={() => setScreen({ name: "bundle-list" })}
          />
        )}
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

export function App(props: {
  view: WorkspaceView;
  bundles: BundleCatalogView;
  launch: RunLaunchView;
  run: RunWorkbenchView;
  /** The Previous Runs read seam and the Run Actions submit seam (#92). Optional
   *  so tests that never reach those screens (e.g. the Bundle screens) need not
   *  wire them; production (`mount.tsx`) always passes the live seams. */
  runList?: RunListView;
  actions?: RunActionsView;
  renderer: RendererPort;
  exit: Exit;
}) {
  const keymap = createTuiKeymap();
  const runList = props.runList ?? stubRunListView();
  const actions = props.actions ?? stubRunActionsView();
  return (
    <ExitProvider exit={props.exit}>
      <ThemeProvider>
        <KeymapProvider keymap={keymap}>
          <WorkspaceViewProvider view={props.view}>
            <BundleCatalogViewProvider view={props.bundles}>
              <RunLaunchViewProvider view={props.launch}>
                <RunWorkbenchViewProvider view={props.run}>
                  <RunListViewProvider view={runList}>
                    <RunActionsViewProvider view={actions}>
                      <DialogProvider>
                        <ErrorBoundary
                          fallback={(error) => (
                            <Fallback error={error} exit={props.exit} />
                          )}
                        >
                          <Route renderer={props.renderer} />
                        </ErrorBoundary>
                      </DialogProvider>
                    </RunActionsViewProvider>
                  </RunListViewProvider>
                </RunWorkbenchViewProvider>
              </RunLaunchViewProvider>
            </BundleCatalogViewProvider>
          </WorkspaceViewProvider>
        </KeymapProvider>
      </ThemeProvider>
    </ExitProvider>
  );
}

// Inert defaults for the screens a given render never opens: an empty Previous
// Runs list and a Run Actions seam that refuses. A screen that actually reaches
// these is always wired with a real seam (production or a test fake).
function stubRunListView(): RunListView {
  return {
    openRunList: () => ({
      state: () => ({
        rows: [],
        filter: "all",
        beginningOfHistory: true,
        hasMore: false,
      }),
      setResumable() {},
      loadMore() {},
    }),
  };
}
function stubRunActionsView(): RunActionsView {
  const refused = () =>
    ({
      kind: "refused",
      problem: {
        code: "run-actions-unavailable",
        explanation: "Run Actions are not wired in this context.",
        remediation: "Open the Run from Previous Runs.",
        possibleEffects: "none",
      },
    }) as const;
  return { resume: refused, cancel: refused, remove: refused };
}
