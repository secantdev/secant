import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { Show } from "solid-js";
import { useBindings } from "./keymap.js";
import { useExit } from "./vendor/exit.js";
import { useTheme } from "./vendor/theme-context.js";
import { useWorkspaceView } from "./workspace-view.js";

// Rebuilt against OpenCode's Home route at commit 1ead9e3d7f. Secant's Home is
// deliberately minimal: the Workspace path and the one command that has a real
// behaviour behind it (quit). No control is shown without a command — the
// Workflow Bundles entry arrives with the slice that lands its screen (ADR
// 0018 "no dead UI"). Every binding here dispatches a real action.

export function Home() {
  const { theme } = useTheme();
  const view = useWorkspaceView();
  const exit = useExit();
  const dimensions = useTerminalDimensions();
  const approved = () => view.snapshot().approval.state === "approved";

  // The quit binding is live only once the Workspace is approved and Home is the
  // interactive surface; while the approval dialog is up it must not fire.
  useBindings(() => ({
    enabled: approved(),
    bindings: [
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
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>q</text>
          <text fg={theme.text}>quit</text>
        </box>
      </Show>
    </box>
  );
}
