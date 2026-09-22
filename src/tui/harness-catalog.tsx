import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  getOwner,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";
import type {
  HarnessFocus,
  HarnessFocusResult,
  HarnessFocusSnapshot,
  HarnessSummary,
} from "../application/projection-port.js";
import { HarnessCatalogInspector } from "./harness-catalog-inspector.js";
import {
  discoveryLabel,
  isQualified,
  qualificationLabel,
} from "./harness-format.js";
import { useHarnessCatalogView } from "./harness-view.js";
import { useBindings } from "./keymap.js";
import { useDialog } from "./vendor/dialog.js";
import { useExit } from "./vendor/exit.js";
import { Panel, PanelGroup } from "./vendor/panels.js";
import { scrollVertically } from "./vendor/scroll.js";
import { useTheme } from "./vendor/theme-context.js";

const STACK_BREAKPOINT = 70;
type THarnessPane = "list" | "inspector";

type THarnessFilterParams = {
  harnesses: readonly HarnessSummary[];
  query: string;
  heldHarness: (id: HarnessSummary["id"]) => HarnessFocus | undefined;
};

type THeldHarnessFocus = {
  snapshot: Accessor<HarnessFocusSnapshot>;
  dispose: () => void;
};

export function HarnessCatalog(props: {
  selected: Accessor<number>;
  setSelected: (index: number) => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const componentOwner = getOwner();
  const view = useHarnessCatalogView();
  const snapshot = view.openList();
  const [query, setQuery] = createSignal("");
  const [pane, setPane] = createSignal<THarnessPane>("list");
  const [openedFocus, setOpenedFocus] = createSignal<
    ReadonlyMap<string, THeldHarnessFocus>
  >(new Map());
  let inspectorScroll: ScrollBoxRenderable | undefined;

  const rows = () => snapshot().harnesses;
  const heldHarness = (id: HarnessSummary["id"]): HarnessFocus | undefined => {
    const result = openedFocus().get(id)?.snapshot().result;
    return result?.found ? result.harness : undefined;
  };
  const ensureFocus = (id: HarnessSummary["id"]): THeldHarnessFocus => {
    const held = openedFocus().get(id);
    if (held !== undefined) return held;
    const opened = createRoot(
      (dispose): THeldHarnessFocus => ({
        snapshot: view.openFocus({ id }),
        dispose,
      }),
      componentOwner,
    );
    const next = new Map(openedFocus());
    next.set(id, opened);
    setOpenedFocus(next);
    return opened;
  };
  onCleanup(() => {
    for (const held of openedFocus().values()) held.dispose();
  });
  const matching = createMemo(() =>
    filterHarnesses({ harnesses: rows(), query: query(), heldHarness }),
  );
  const activeEntry = () =>
    matching().find((entry) => entry.index === props.selected()) ??
    matching()[0];

  createEffect(() => {
    const active = activeEntry();
    if (active !== undefined && active.index !== props.selected()) {
      props.setSelected(active.index);
    }
  });

  const focus = createMemo(() => {
    const entry = activeEntry();
    if (entry === undefined) return undefined;
    return ensureFocus(entry.harness.id).snapshot;
  });
  const focusedResult = (): HarnessFocusResult | undefined =>
    focus()?.().result;

  let scrolledHarness: string | undefined;
  createEffect(() => {
    const id = activeEntry()?.harness.id;
    if (id === scrolledHarness) return;
    scrolledHarness = id;
    inspectorScroll?.scrollTo(0);
  });

  createEffect(() => {
    for (const harness of rows()) {
      if (harness.qualification.state !== "not-checked") {
        ensureFocus(harness.id);
      }
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
    if (entry !== undefined) props.setSelected(entry.index);
  };
  const updateQuery = (value: string) => {
    setQuery(value);
    const entries = filterHarnesses({
      harnesses: rows(),
      query: value,
      heldHarness,
    });
    if (!entries.some((entry) => entry.index === props.selected())) {
      const first = entries[0];
      if (first !== undefined) props.setSelected(first.index);
    }
  };
  const scroll = (delta: number) => scrollVertically(inspectorScroll, delta);

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      {
        key: "up",
        desc: pane() === "list" ? "Previous Harness" : "Scroll up",
        group: "Harnesses",
        cmd: () => (pane() === "list" ? moveSelection(-1) : scroll(-1)),
      },
      {
        key: "down",
        desc: pane() === "list" ? "Next Harness" : "Scroll down",
        group: "Harnesses",
        cmd: () => (pane() === "list" ? moveSelection(1) : scroll(1)),
      },
      {
        key: "tab",
        desc: "Switch pane",
        group: "Harnesses",
        cmd: () =>
          setPane((current) => (current === "list" ? "inspector" : "list")),
      },
      { key: "escape", desc: "Back", group: "Harnesses", cmd: props.onBack },
      { key: "ctrl+c", desc: "Quit", group: "Harnesses", cmd: () => exit() },
    ],
  }));
  useBindings(() => ({
    enabled: pane() === "inspector" && dialog.stack.length === 0,
    bindings: [
      {
        key: "pageup",
        desc: "Page inspector up",
        group: "Harnesses",
        cmd: () => scroll(-Math.max(1, inspectorScroll?.viewport.height ?? 1)),
      },
      {
        key: "pagedown",
        desc: "Page inspector down",
        group: "Harnesses",
        cmd: () => scroll(Math.max(1, inspectorScroll?.viewport.height ?? 1)),
      },
      {
        key: "left",
        desc: "Focus results",
        group: "Harnesses",
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
        group: "Harnesses",
        cmd: () => setPane("inspector"),
      },
    ],
  }));

  const qualified = () =>
    rows().filter((harness) => isQualified(harness.qualification)).length;
  const stacked = () => dimensions().width < STACK_BREAKPOINT;

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
      <box flexDirection="column" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Harnesses
        </text>
        <text fg={theme.textMuted}>
          {`${rows().length} discovered · ${qualified()} qualified on this system`}
        </text>
      </box>
      <PanelGroup
        axis={stacked() ? "y" : "x"}
        flexGrow={1}
        overflow="hidden"
        gap={1}
      >
        <Panel
          title="Find a Harness"
          focused={pane() === "list"}
          width={stacked() ? undefined : 34}
          height={stacked() ? 10 : undefined}
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          overflow="hidden"
        >
          <input
            focused={pane() === "list"}
            value={query()}
            onInput={updateQuery}
            placeholder="name, model, or capability"
            placeholderColor={theme.textMuted}
            cursorColor={theme.accent}
            focusedBackgroundColor={theme.backgroundElement}
            focusedTextColor={theme.text}
          />
          <Show when={matching().length > 0} fallback={<NoMatches />}>
            <box flexDirection="column" flexGrow={1} overflow="hidden">
              <For each={matching()}>
                {(entry) => (
                  <ResultRow
                    harness={entry.harness}
                    focusedHarness={() => heldHarness(entry.harness.id)}
                    selected={entry.index === activeEntry()?.index}
                    focused={pane() === "list"}
                    onSelect={() => props.setSelected(entry.index)}
                  />
                )}
              </For>
            </box>
          </Show>
        </Panel>
        <Panel
          title="Inspector"
          focused={pane() === "inspector"}
          flexGrow={1}
          overflow="hidden"
        >
          <Show
            when={focusedResult()}
            fallback={
              <text fg={theme.textMuted} paddingLeft={1}>
                Clear or change the search to inspect a Harness.
              </text>
            }
          >
            {(result) => (
              <Show
                when={foundHarness(result())}
                fallback={
                  <text fg={theme.textMuted} paddingLeft={1}>
                    {notFoundExplanation(result()) ?? "No Harness selected"}
                  </text>
                }
              >
                {(harness) => (
                  <scrollbox
                    ref={(element: ScrollBoxRenderable) =>
                      (inspectorScroll = element)
                    }
                    flexGrow={1}
                    minHeight={0}
                    paddingLeft={1}
                    paddingRight={1}
                    verticalScrollbarOptions={{ visible: false }}
                    horizontalScrollbarOptions={{ visible: false }}
                  >
                    <HarnessCatalogInspector harness={harness} />
                  </scrollbox>
                )}
              </Show>
            )}
          </Show>
        </Panel>
      </PanelGroup>
      <text fg={theme.textMuted} flexShrink={0}>
        tab/←/→ switch pane · ↑/↓ move or scroll · esc back · ctrl+c quit
      </text>
    </box>
  );
}

function filterHarnesses(params: THarnessFilterParams) {
  const needle = params.query.trim().toLocaleLowerCase();
  return params.harnesses
    .map((harness, index) => ({ harness, index }))
    .filter(({ harness }) => {
      if (needle.length === 0) return true;
      const focused = params.heldHarness(harness.id);
      const models =
        focused?.supportedModels?.kind === "list"
          ? focused.supportedModels.models.join(" ")
          : focused?.supportedModels?.kind === "free-text"
            ? "free-text"
            : "";
      const capabilities =
        focused?.capabilities
          .flatMap((capability) => [
            capability.name,
            capability.description,
            capability.state,
            capability.limits ?? "",
          ])
          .join(" ") ?? "";
      return [
        harness.name,
        harness.id,
        qualificationLabel(harness.qualification.state),
        models,
        capabilities,
      ].some((value) => value.toLocaleLowerCase().includes(needle));
    });
}

function ResultRow(props: {
  harness: HarnessSummary;
  focusedHarness: Accessor<HarnessFocus | undefined>;
  selected: boolean;
  focused: boolean;
  onSelect: () => void;
}) {
  const { theme } = useTheme();
  const modelCount = () => {
    const declaration = props.focusedHarness()?.supportedModels;
    return declaration?.kind === "list"
      ? `${declaration.models.length} models observed`
      : "Models not yet observed";
  };
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
        {`${props.selected && props.focused ? "› " : "  "}${props.harness.name} · ${qualificationLabel(props.harness.qualification.state)}`}
      </text>
      <text fg={theme.textMuted}>
        {`  ${discoveryLabel(props.harness.discovery)}`}
      </text>
      <text fg={theme.textMuted}>{`  ${modelCount()}`}</text>
    </box>
  );
}

function foundHarness(result: HarnessFocusResult): HarnessFocus | undefined {
  return result.found ? result.harness : undefined;
}

function notFoundExplanation(result: HarnessFocusResult): string | undefined {
  return result.found ? undefined : result.problem.explanation;
}

function NoMatches() {
  const { theme } = useTheme();
  return (
    <box flexDirection="column" paddingTop={1} flexShrink={0}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        No matching Harnesses
      </text>
      <text fg={theme.textMuted}>
        Try a different name, capability, model, or qualification state.
      </text>
    </box>
  );
}
