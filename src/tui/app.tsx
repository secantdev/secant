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
import { DialogProvider, useDialog } from "./vendor/dialog.js";
import { EpilogueProvider } from "./vendor/epilogue.js";
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
// row (#57).

type Screen =
  | { readonly name: "home" }
  | { readonly name: "bundle-list" }
  | { readonly name: "bundle-inspect"; readonly selector: BundleFocusSelector };

function Route() {
  const view = useWorkspaceView();
  const dialog = useDialog();
  const exit = useExit();
  const approved = () => view.snapshot().approval.state === "approved";

  const [screen, setScreen] = createSignal<Screen>({ name: "home" });
  const [selected, setSelected] = createSignal(0);
  // Narrow the union to the inspect variant so its `selector` reaches the child
  // typed, with no `as` cast: the accessor is undefined for every other screen.
  const inspecting = () => {
    const current = screen();
    return current.name === "bundle-inspect" ? current : undefined;
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
        <Home onOpenBundles={() => setScreen({ name: "bundle-list" })} />
      }
    >
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
  exit: Exit;
  onEpilogue?: (value?: string) => void;
}) {
  const keymap = createTuiKeymap();
  return (
    <ExitProvider exit={props.exit}>
      <EpilogueProvider set={props.onEpilogue ?? (() => {})}>
        <ThemeProvider>
          <KeymapProvider keymap={keymap}>
            <WorkspaceViewProvider view={props.view}>
              <BundleCatalogViewProvider view={props.bundles}>
                <DialogProvider>
                  <ErrorBoundary
                    fallback={(error) => (
                      <Fallback error={error} exit={props.exit} />
                    )}
                  >
                    <Route />
                  </ErrorBoundary>
                </DialogProvider>
              </BundleCatalogViewProvider>
            </WorkspaceViewProvider>
          </KeymapProvider>
        </ThemeProvider>
      </EpilogueProvider>
    </ExitProvider>
  );
}
