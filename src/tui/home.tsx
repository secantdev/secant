import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { Show } from "solid-js";
import { useBindings } from "./keymap.js";
import { useExit } from "./vendor/exit.js";
import { useTheme } from "./vendor/theme-context.js";
import { useWorkspaceView } from "./workspace-view.js";

// Rebuilt against OpenCode's Home route at commit 1ead9e3d7f. Secant's Home is
// deliberately minimal: the Workspace path and the commands that have a real
// behaviour behind them. No control is shown without a command — the Workflow
// Bundles entry lands with #57's screen (ADR 0018 "no dead UI"): Enter opens the
// Bundle list. Every binding here dispatches a real action.

export function Home(props: { onOpenBundles: () => void }) {
  const { theme } = useTheme();
  const view = useWorkspaceView();
  const exit = useExit();
  const dimensions = useTerminalDimensions();
  const approved = () => view.snapshot().approval.state === "approved";

  // Bindings are live only once the Workspace is approved and Home is the
  // interactive surface; while the approval dialog is up they must not fire.
  useBindings(() => ({
    enabled: approved(),
    bindings: [
      {
        key: "return",
        desc: "Workflow Bundles",
        group: "Home",
        cmd: () => props.onOpenBundles(),
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
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Secant
      </text>
      <box flexDirection="column">
        <text fg={theme.textMuted}>Workspace</text>
        <text fg={theme.text}>{view.snapshot().path}</text>
      </box>
      <Show when={approved()}>
        <box flexDirection="column">
          <text fg={theme.textMuted}>Menu</text>
          <text fg={theme.text}>› Workflow Bundles</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>enter open · q quit</text>
        </box>
      </Show>
    </box>
  );
}
