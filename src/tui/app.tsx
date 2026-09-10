import { createEffect, ErrorBoundary, onMount } from "solid-js";
import { ApprovalDialog } from "./approval-dialog.js";
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

// The application root. Home is the one base route; the approval dialog overlays
// it through the vendored dialog primitive while the launch Workspace is
// unapproved. Approving submits `approve-workspace`, the snapshot flips, and the
// route resolves to an interactive Home — no separate navigation needed, so the
// route model is exactly this: approval state selects the surface.

function Route() {
  const view = useWorkspaceView();
  const dialog = useDialog();
  const exit = useExit();
  const approved = () => view.snapshot().approval.state === "approved";

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

  return <Home />;
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
              <DialogProvider>
                <ErrorBoundary
                  fallback={(error) => (
                    <Fallback error={error} exit={props.exit} />
                  )}
                >
                  <Route />
                </ErrorBoundary>
              </DialogProvider>
            </WorkspaceViewProvider>
          </KeymapProvider>
        </ThemeProvider>
      </EpilogueProvider>
    </ExitProvider>
  );
}
