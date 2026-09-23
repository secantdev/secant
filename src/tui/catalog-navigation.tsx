import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type Accessor,
} from "solid-js";
import { useBindings } from "./keymap.js";
import { useDialog } from "./vendor/dialog.js";
import { useExit } from "./vendor/exit.js";
import { scrollVertically } from "./vendor/scroll.js";
import { useTheme } from "./vendor/theme-context.js";

// The navigation both two-pane catalogs share (Bundle and Harness, A4): the
// search query, pane focus, selection that follows the filtered entries, and
// the up/down/tab/escape/page/left/right bindings. Rows, focus derivation,
// filters, and inspectors stay with each screen.

type TCatalogEntry = { readonly index: number };

type TCatalogNavigationParams<TEntry extends TCatalogEntry> = {
  /** The screen's entries matching `query`, each carrying its row index. */
  filter: (query: string) => readonly TEntry[];
  selected: Accessor<number>;
  setSelected: (index: number) => void;
  onBack: () => void;
  /** The key-group label, e.g. "Harnesses". */
  group: string;
  /** The row noun in the list-pane key descriptions, e.g. "Harness". */
  item: string;
  inspector: () => ScrollBoxRenderable | undefined;
};

export function useCatalogNavigation<TEntry extends TCatalogEntry>(
  params: TCatalogNavigationParams<TEntry>,
) {
  const exit = useExit();
  const dialog = useDialog();
  const [query, setQuery] = createSignal("");
  const [pane, setPane] = createSignal<"list" | "inspector">("list");
  const matching = createMemo(() => params.filter(query()));
  const activeEntry = () =>
    matching().find((entry) => entry.index === params.selected()) ??
    matching()[0];

  createEffect(() => {
    const active = activeEntry();
    if (active !== undefined && active.index !== params.selected()) {
      params.setSelected(active.index);
    }
  });

  const moveSelection = (delta: number) => {
    const entries = matching();
    if (entries.length === 0) return;
    const position = Math.max(
      0,
      entries.findIndex((entry) => entry.index === activeEntry()?.index),
    );
    const next = Math.max(0, Math.min(position + delta, entries.length - 1));
    const entry = entries[next];
    if (entry !== undefined) params.setSelected(entry.index);
  };
  const updateQuery = (value: string) => {
    setQuery(value);
    const entries = params.filter(value);
    if (!entries.some((entry) => entry.index === params.selected())) {
      const first = entries[0];
      if (first !== undefined) params.setSelected(first.index);
    }
  };
  const scroll = (delta: number) => scrollVertically(params.inspector(), delta);
  const page = () => Math.max(1, params.inspector()?.viewport.height ?? 1);
  const group = params.group;

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      {
        key: "up",
        desc: pane() === "list" ? `Previous ${params.item}` : "Scroll up",
        group,
        cmd: () => (pane() === "list" ? moveSelection(-1) : scroll(-1)),
      },
      {
        key: "down",
        desc: pane() === "list" ? `Next ${params.item}` : "Scroll down",
        group,
        cmd: () => (pane() === "list" ? moveSelection(1) : scroll(1)),
      },
      {
        key: "tab",
        desc: "Switch pane",
        group,
        cmd: () =>
          setPane((current) => (current === "list" ? "inspector" : "list")),
      },
      { key: "escape", desc: "Back", group, cmd: params.onBack },
      { key: "ctrl+c", desc: "Quit", group, cmd: () => exit() },
    ],
  }));
  useBindings(() => ({
    enabled: pane() === "inspector" && dialog.stack.length === 0,
    bindings: [
      {
        key: "pageup",
        desc: "Page inspector up",
        group,
        cmd: () => scroll(-page()),
      },
      {
        key: "pagedown",
        desc: "Page inspector down",
        group,
        cmd: () => scroll(page()),
      },
      {
        key: "left",
        desc: "Focus results",
        group,
        cmd: () => setPane("list"),
      },
    ],
  }));
  useBindings(() => ({
    enabled: pane() === "list" && dialog.stack.length === 0,
    bindings: [
      {
        key: "right",
        desc: "Focus inspector",
        group,
        cmd: () => setPane("inspector"),
      },
    ],
  }));

  return { query, pane, matching, activeEntry, updateQuery };
}

export function CatalogEmptyState(props: { title: string; hint: string }) {
  const { theme } = useTheme();
  return (
    <box flexDirection="column" paddingTop={1} flexShrink={0}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        {props.title}
      </text>
      <text fg={theme.textMuted}>{props.hint}</text>
    </box>
  );
}

export function CatalogRow(props: {
  title: string;
  details: readonly string[];
  selected: boolean;
  focused: boolean;
  onSelect: () => void;
}) {
  const { theme } = useTheme();
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={props.selected ? theme.backgroundElement : undefined}
      onMouseUp={props.onSelect}
    >
      <text
        fg={props.selected ? theme.text : theme.textMuted}
        attributes={props.selected ? TextAttributes.BOLD : 0}
      >
        {`${props.selected && props.focused ? "› " : "  "}${props.title}`}
      </text>
      <For each={props.details}>
        {(detail) => <text fg={theme.textMuted}>{`  ${detail}`}</text>}
      </For>
    </box>
  );
}
