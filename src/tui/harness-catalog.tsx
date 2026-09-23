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
import {
  CatalogEmptyState,
  CatalogRow,
  useCatalogNavigation,
} from "./catalog-navigation.js";
import { HarnessCatalogInspector } from "./harness-catalog-inspector.js";
import {
  discoveryLabel,
  isQualified,
  qualificationLabel,
} from "./harness-format.js";
import { useHarnessCatalogView } from "./harness-view.js";
import { Panel, PanelGroup } from "./vendor/panels.js";
import { useTheme } from "./vendor/theme-context.js";

const STACK_BREAKPOINT = 70;

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
  const dimensions = useTerminalDimensions();
  const componentOwner = getOwner();
  const view = useHarnessCatalogView();
  const snapshot = view.openList();
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
  const { query, pane, matching, activeEntry, updateQuery } =
    useCatalogNavigation({
      filter: (value) =>
        filterHarnesses({ harnesses: rows(), query: value, heldHarness }),
      selected: props.selected,
      setSelected: props.setSelected,
      onBack: props.onBack,
      group: "Harnesses",
      item: "Harness",
      inspector: () => inspectorScroll,
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
          <Show
            when={matching().length > 0}
            fallback={
              <CatalogEmptyState
                title="No matching Harnesses"
                hint="Try a different name, capability, model, or qualification state."
              />
            }
          >
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
  const modelCount = () => {
    const declaration = props.focusedHarness()?.supportedModels;
    return declaration?.kind === "list"
      ? `${declaration.models.length} models observed`
      : "Models not yet observed";
  };
  return (
    <CatalogRow
      title={`${props.harness.name} · ${qualificationLabel(props.harness.qualification.state)}`}
      details={[discoveryLabel(props.harness.discovery), modelCount()]}
      selected={props.selected}
      focused={props.focused}
      onSelect={props.onSelect}
    />
  );
}

function foundHarness(result: HarnessFocusResult): HarnessFocus | undefined {
  return result.found ? result.harness : undefined;
}

function notFoundExplanation(result: HarnessFocusResult): string | undefined {
  return result.found ? undefined : result.problem.explanation;
}
