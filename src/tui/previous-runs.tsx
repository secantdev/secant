import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
  type Accessor,
} from "solid-js";
import type {
  RunListGroup,
  RunListRow,
} from "../application/projection-port.js";
import { clip } from "./clip.js";
import { useBindings } from "./keymap.js";
import { useRunListView } from "./run-list-view.js";
import { useExit } from "./vendor/exit.js";
import { useDialog } from "./vendor/dialog.js";
import { useTheme } from "./vendor/theme-context.js";

// The Previous Runs list (#92): the Workspace's earlier Runs, newest durable
// activity first, grouped Today / Yesterday / Older, each row carrying only the
// Run id, activity time, live marker, and Bundle human name (the Bundle name truncates last on
// a small width). Selection mirrors bundle-list.tsx — a clamped active index moved
// by up/down, Enter opens the selected Run's Workbench, Escape returns to Home,
// the leading "› " glyph reads focus without colour. `f` toggles the Resumable
// filter (halted+failed). Older Runs load automatically as the selection nears the
// loaded end (run-list-view.ts pages by cursor); because older rows append below,
// the first visible row and the viewport stay fixed. The final page ends in an
// explicit beginning-of-history marker; an empty list is informational with Back.

const GROUP_HEADINGS: Record<RunListGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  older: "Older",
};

/** Load the next older page once the selection is within this many rows of the
 *  loaded end, so paging happens a little before the very last row (#92 AC2). */
const LOAD_THRESHOLD = 3;

/** One rendered line: a group heading, a Run row, or the end-of-history marker.
 *  Only `row` items are selectable; headings and the marker window past like any
 *  other line but the selection skips them. */
type DisplayItem =
  | { readonly kind: "heading"; readonly group: RunListGroup }
  | {
      readonly kind: "row";
      readonly row: RunListRow;
      readonly rowIndex: number;
    }
  | { readonly kind: "marker" };

export function PreviousRuns(props: {
  selected: Accessor<number>;
  setSelected: (index: number) => void;
  onOpen: (runId: string) => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const view = useRunListView();
  const controller = view.openRunList();

  const [resumable, setResumable] = createSignal(false);
  const [top, setTop] = createSignal(0);

  const rows = () => controller.state().rows;
  const active = () =>
    Math.min(props.selected(), Math.max(0, rows().length - 1));

  // The flat display list: a heading before each group's first row, the rows, and
  // the beginning-of-history marker on the final page. `rowToDisplay[i]` is the
  // display index of row `i`, so the viewport can keep the selected row visible.
  const display = createMemo(() => {
    const items: DisplayItem[] = [];
    const rowToDisplay: number[] = [];
    let group: RunListGroup | undefined;
    rows().forEach((row, rowIndex) => {
      if (row.group !== group) {
        group = row.group;
        items.push({ kind: "heading", group });
      }
      rowToDisplay.push(items.length);
      items.push({ kind: "row", row, rowIndex });
    });
    if (rows().length > 0 && controller.state().beginningOfHistory) {
      items.push({ kind: "marker" });
    }
    return { items, rowToDisplay };
  });

  // Interior height less the title, filter line, and footer (padding=1 trims 2).
  const viewportH = () => Math.max(1, dimensions().height - 5);

  // The visible slice, clamping `top` so it never scrolls past the ends; appends
  // below the viewport leave this slice untouched (the paging anchor, #92 AC2).
  const window = createMemo(() => {
    const items = display().items;
    const height = viewportH();
    const maxTop = Math.max(0, items.length - height);
    const clampedTop = Math.min(Math.max(top(), 0), maxTop);
    return {
      top: clampedTop,
      items: items.slice(clampedTop, clampedTop + height),
    };
  });

  // Keep the selected row inside the viewport, scrolling the window the least
  // amount needed. Called after every selection move and once at mount so a
  // restored row (Escape from a Run) is visible.
  const ensureVisible = (rowIndex: number) => {
    const displayIndex = display().rowToDisplay[rowIndex];
    if (displayIndex === undefined) return;
    const height = viewportH();
    setTop((current) => {
      if (displayIndex < current) return displayIndex;
      if (displayIndex >= current + height) return displayIndex - height + 1;
      return current;
    });
  };

  const move = (delta: number) => {
    const count = rows().length;
    if (count === 0) return;
    const next = Math.max(0, Math.min(active() + delta, count - 1));
    props.setSelected(next);
    // Page older before the selection hits the very end (#92 AC2); loadMore is a
    // no-op once the beginning of history is reached.
    if (controller.state().hasMore && next >= count - LOAD_THRESHOLD) {
      controller.loadMore();
    }
    ensureVisible(next);
  };

  const toggleFilter = () => {
    const next = !resumable();
    setResumable(next);
    controller.setResumable(next);
    props.setSelected(0);
    setTop(0);
  };

  onMount(() => {
    // Restore a selection that lived on a later page (Escape from a Run opened
    // deep in the list): the list remounts with only the first page, so page
    // forward by cursor until the saved index is loaded, then bring it into view.
    // Bounded by `hasMore`, so it stops at the beginning of history.
    while (props.selected() >= rows().length && controller.state().hasMore) {
      controller.loadMore();
    }
    ensureVisible(active());
  });

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "up", desc: "Previous", group: "Runs", cmd: () => move(-1) },
      { key: "down", desc: "Next", group: "Runs", cmd: () => move(1) },
      {
        key: "return",
        desc: "Open",
        group: "Runs",
        cmd: () => {
          const row = rows()[active()];
          if (row) props.onOpen(row.runId);
        },
      },
      { key: "f", desc: "Filter", group: "Runs", cmd: toggleFilter },
      { key: "escape", desc: "Back", group: "Runs", cmd: props.onBack },
      { key: "q", desc: "Quit", group: "Runs", cmd: () => exit() },
      { key: "ctrl+c", desc: "Quit", group: "Runs", cmd: () => exit() },
    ],
  }));

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Previous Runs
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {`Filter: ${resumable() ? "Resumable" : "All Runs"} · f to toggle`}
      </text>
      <Show
        when={rows().length > 0}
        fallback={
          <box flexDirection="column" flexGrow={1} flexShrink={0}>
            <text fg={theme.textMuted}>
              {resumable()
                ? "No resumable runs. Press f to show all runs."
                : "No runs yet. Start a Run from Home."}
            </text>
            <text fg={theme.textMuted}>esc back · q quit</text>
          </box>
        }
      >
        <box
          flexDirection="column"
          height={viewportH()}
          flexShrink={0}
          overflow="hidden"
        >
          <For each={window().items}>
            {(item) => (
              <Line
                item={item}
                active={active()}
                width={Math.max(1, dimensions().width - 2)}
                theme={theme}
              />
            )}
          </For>
        </box>
      </Show>
      <text fg={theme.textMuted} flexShrink={0}>
        ↑/↓ move · enter open · f filter · esc back · q quit
      </text>
    </box>
  );
}

type Theme = ReturnType<typeof useTheme>["theme"];

function Line(props: {
  item: DisplayItem;
  active: number;
  width: number;
  theme: Theme;
}) {
  const { theme } = props;
  const item = props.item;
  if (item.kind === "heading") {
    return (
      <text
        fg={theme.textMuted}
        attributes={TextAttributes.BOLD}
        flexShrink={0}
      >
        {clip(GROUP_HEADINGS[item.group], props.width)}
      </text>
    );
  }
  if (item.kind === "marker") {
    return (
      <text fg={theme.textMuted} flexShrink={0}>
        {clip("  (beginning of history)", props.width)}
      </text>
    );
  }
  // Read selection reactively (a getter, not a one-time const) so the focus glyph
  // and highlight follow up/down without re-slicing the window.
  const selected = () => item.rowIndex === props.active;
  // One concatenated string per line: Run id, activity time, and live marker first so the
  // Bundle name (last) is what a narrow width truncates.
  return (
    <text
      fg={selected() ? theme.text : theme.textMuted}
      attributes={selected() ? TextAttributes.BOLD : 0}
      flexShrink={0}
    >
      {clip(
        `${selected() ? "› " : "  "}${item.row.runId}  ${item.row.activityAt}${item.row.live ? "  ● live" : ""}  ${item.row.bundleName}`,
        props.width,
      )}
    </text>
  );
}
