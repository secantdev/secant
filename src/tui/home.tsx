import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createSignal, For, Show } from "solid-js";
import { useBindings } from "./keymap.js";
import { useExit } from "./vendor/exit.js";
import { useDialog } from "./vendor/dialog.js";
import { useTheme } from "./vendor/theme-context.js";
import { useWorkspaceView } from "./workspace-view.js";

// Rebuilt against OpenCode's Home route at commit 1ead9e3d7f. Secant's Home is
// deliberately minimal: the Workspace path and the commands that have a real
// behaviour behind them. No control is shown without a command (ADR 0018 "no
// dead UI"): every menu entry dispatches a real action. Start a Run (#90) sits
// beside Workflow Bundles (#57), so the menu is a small selectable list — up/down
// move, Enter opens the active entry.

export function Home(props: {
  onStartRun: () => void;
  onOpenBundles: () => void;
  onOpenPreviousRuns: () => void;
}) {
  const { theme } = useTheme();
  const view = useWorkspaceView();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const approved = () => view.snapshot().approval.state === "approved";

  // Workflow Bundles stays the first entry so Enter from a fresh Home opens it;
  // Start a Run sits beside it (#90).
  const entries = () => [
    { label: "Workflow Bundles", open: () => props.onOpenBundles() },
    { label: "Start a Run", open: () => props.onStartRun() },
    { label: "Previous Runs", open: () => props.onOpenPreviousRuns() },
  ];
  const [selected, setSelected] = createSignal(0);
  const move = (delta: number) =>
    setSelected(
      Math.max(0, Math.min(selected() + delta, entries().length - 1)),
    );

  // Bindings are live only once the Workspace is approved and Home is the
  // interactive surface; while the approval dialog is up they must not fire.
  useBindings(() => ({
    enabled: approved() && dialog.stack.length === 0,
    bindings: [
      { key: "up", desc: "Previous", group: "Home", cmd: () => move(-1) },
      { key: "down", desc: "Next", group: "Home", cmd: () => move(1) },
      {
        key: "return",
        desc: "Open",
        group: "Home",
        cmd: () => entries()[selected()]?.open(),
      },
      { key: "q", desc: "Quit", group: "Home", cmd: () => exit() },
      { key: "ctrl+c", desc: "Quit", group: "Home", cmd: () => exit() },
    ],
  }));

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      gap={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Secant
      </text>
      <box flexDirection="column" flexShrink={0}>
        <text fg={theme.textMuted}>Workspace</text>
        <text fg={theme.text}>{view.snapshot().path}</text>
      </box>
      <Show when={approved()}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={theme.textMuted}>Menu</text>
          <For each={entries()}>
            {(entry, index) => (
              <text
                fg={theme.text}
                attributes={index() === selected() ? TextAttributes.BOLD : 0}
                flexShrink={0}
              >
                {`${index() === selected() ? "› " : "  "}${entry.label}`}
              </text>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={theme.textMuted}>↑/↓ move · enter open · q quit</text>
        </box>
      </Show>
    </box>
  );
}
