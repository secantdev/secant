import { TextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { createStore } from "solid-js/store";
import { useBindings } from "./keymap.js";
import { useExit } from "./vendor/exit.js";
import { useTheme } from "./vendor/theme-context.js";
import { useWorkspaceView } from "./workspace-view.js";

// Rebuilt against OpenCode packages/tui/src/ui/dialog-confirm.tsx at commit
// 1ead9e3d7f. Taken: the two-option confirm shape (left/right to move, Return to
// choose, a highlighted active option) and the header/esc row. Changed: the
// generic confirm/cancel resolves become Secant's Approve (submit
// `approve-workspace`) and Decline (exit); the exact absolute Workspace path is
// the body; and state is carried by the highlight AND a leading "› " marker so
// the active option is readable without colour (ADR 0024 / #19).

export function ApprovalDialog() {
  const { theme } = useTheme();
  const view = useWorkspaceView();
  const exit = useExit();
  const [store, setStore] = createStore({
    active: "approve" as "approve" | "decline",
  });

  const toggle = () =>
    setStore("active", store.active === "approve" ? "decline" : "approve");

  const choose = (option: "approve" | "decline") => {
    if (option === "approve") view.approve();
    else exit("declined");
  };

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Choose",
        group: "Approval",
        cmd: () => choose(store.active),
      },
      { key: "left", desc: "Previous option", group: "Approval", cmd: toggle },
      { key: "right", desc: "Next option", group: "Approval", cmd: toggle },
      { key: "tab", desc: "Next option", group: "Approval", cmd: toggle },
    ],
  }));

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Approve this workspace?
        </text>
        <text fg={theme.textMuted} onMouseUp={() => exit("declined")}>
          esc
        </text>
      </box>
      <box paddingBottom={1} flexDirection="column">
        <text fg={theme.textMuted}>
          Secant will only act inside this directory:
        </text>
        <text fg={theme.text}>{view.snapshot().path}</text>
      </box>
      <box
        flexDirection="row"
        justifyContent="flex-end"
        gap={1}
        paddingBottom={1}
      >
        <For each={["decline", "approve"] as const}>
          {(key) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={key === store.active ? theme.primary : undefined}
              onMouseUp={() => choose(key)}
            >
              <text
                fg={
                  key === store.active
                    ? theme.selectedListItemText
                    : theme.textMuted
                }
              >
                {(key === store.active ? "› " : "  ") +
                  (key === "approve" ? "Approve" : "Decline")}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  );
}
