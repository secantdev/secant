import type { JSX } from "@opentui/solid";
import { splitProps, type ParentProps } from "solid-js";
import { useTheme } from "./theme-context.js";

// Reduced from OpenCode's diff-viewer-ui.tsx PanelGroup/Panel pair at
// 1ead9e3d7f (see UPSTREAM). The generic axis-aware layout is retained; the
// diff-specific separators, edge glyphs, and configurable border vocabulary are
// omitted. Secant adds a focus title so either pane remains identifiable without
// colour when the layout changes from columns to a stack.

type Axis = "x" | "y";

export function PanelGroup(
  props: JSX.IntrinsicElements["box"] & { readonly axis: Axis },
) {
  const [local, boxProps] = splitProps(props, ["axis", "children"]);
  return (
    <box
      minWidth={0}
      minHeight={0}
      padding={0}
      flexDirection={local.axis === "x" ? "row" : "column"}
      {...boxProps}
    >
      {local.children}
    </box>
  );
}

export function Panel(
  props: ParentProps<
    Omit<JSX.IntrinsicElements["box"], "border" | "title"> & {
      readonly focused: boolean;
      readonly title: string;
    }
  >,
) {
  const { theme } = useTheme();
  const [local, boxProps] = splitProps(props, ["focused", "title", "children"]);
  return (
    <box
      minWidth={0}
      minHeight={0}
      flexDirection="column"
      border
      borderColor={local.focused ? theme.accent : theme.border}
      title={`${local.focused ? "› " : "  "}${local.title}`}
      titleColor={local.focused ? theme.text : theme.textMuted}
      {...boxProps}
    >
      {local.children}
    </box>
  );
}
