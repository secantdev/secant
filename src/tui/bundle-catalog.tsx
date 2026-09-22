import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type Accessor,
} from "solid-js";
import type {
  BundleFocusResult,
  InstalledBundleFocus,
  InstalledBundleSummary,
} from "../application/projection-port.js";
import { BundleCatalogInspector } from "./bundle-catalog-inspector.js";
import { useBundleCatalogView } from "./bundle-view.js";
import { useBindings } from "./keymap.js";
import { useDialog } from "./vendor/dialog.js";
import { useExit } from "./vendor/exit.js";
import { Panel, PanelGroup } from "./vendor/panels.js";
import { scrollVertically } from "./vendor/scroll.js";
import { useTheme } from "./vendor/theme-context.js";

// One read-only Workflow Bundles catalog over the existing list/focus
// Projections. Its two-pane shape is reduced from OpenCode's diff viewer and its
// selection/search shape from dialog-select.tsx at 1ead9e3d7f (see UPSTREAM).
// Secant keeps substring search presentation-only, exposes no Action Offers,
// marks focus in words/glyphs, stacks at a small width, and clamps scrolling.

const STACK_BREAKPOINT = 70;

type Pane = "list" | "inspector";

export function BundleCatalog(props: {
  selected: Accessor<number>;
  setSelected: (index: number) => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const view = useBundleCatalogView();
  const snapshot = view.openList();
  const [query, setQuery] = createSignal("");
  const [pane, setPane] = createSignal<Pane>("list");
  let inspectorScroll: ScrollBoxRenderable | undefined;

  const rows = () => {
    const result = snapshot().result;
    return result.found ? result.bundles : [];
  };
  const listProblem = () => {
    const result = snapshot().result;
    return result.found ? undefined : result.problem;
  };
  const matching = createMemo(() => filterBundles(rows(), query()));
  const activeEntry = () => {
    const selected = matching().find(
      (entry) => entry.index === props.selected(),
    );
    return selected ?? matching()[0];
  };

  createEffect(() => {
    const active = activeEntry();
    if (active !== undefined && active.index !== props.selected()) {
      props.setSelected(active.index);
    }
  });

  const focus = createMemo(() => {
    const entry = activeEntry();
    if (entry === undefined) return undefined;
    return view.openFocus({
      id: entry.bundle.id,
      version: entry.bundle.version,
    });
  });
  const focusedResult = (): BundleFocusResult | undefined => focus()?.().result;

  let scrolledBundle: string | undefined;
  createEffect(() => {
    const entry = activeEntry();
    const identity =
      entry === undefined
        ? undefined
        : `${entry.bundle.id}@${entry.bundle.version}`;
    if (identity === scrolledBundle) return;
    scrolledBundle = identity;
    inspectorScroll?.scrollTo(0);
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
    const entries = filterBundles(rows(), value);
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
        desc: pane() === "list" ? "Previous Bundle" : "Scroll up",
        group: "Workflow Bundles",
        cmd: () => (pane() === "list" ? moveSelection(-1) : scroll(-1)),
      },
      {
        key: "down",
        desc: pane() === "list" ? "Next Bundle" : "Scroll down",
        group: "Workflow Bundles",
        cmd: () => (pane() === "list" ? moveSelection(1) : scroll(1)),
      },
      {
        key: "tab",
        desc: "Switch pane",
        group: "Workflow Bundles",
        cmd: () =>
          setPane((current) => (current === "list" ? "inspector" : "list")),
      },
      {
        key: "escape",
        desc: "Back",
        group: "Workflow Bundles",
        cmd: props.onBack,
      },
      {
        key: "ctrl+c",
        desc: "Quit",
        group: "Workflow Bundles",
        cmd: () => exit(),
      },
    ],
  }));
  useBindings(() => ({
    enabled: pane() === "inspector" && dialog.stack.length === 0,
    bindings: [
      {
        key: "pageup",
        desc: "Page inspector up",
        group: "Workflow Bundles",
        cmd: () => scroll(-Math.max(1, inspectorScroll?.viewport.height ?? 1)),
      },
      {
        key: "pagedown",
        desc: "Page inspector down",
        group: "Workflow Bundles",
        cmd: () => scroll(Math.max(1, inspectorScroll?.viewport.height ?? 1)),
      },
      {
        key: "left",
        desc: "Focus results",
        group: "Workflow Bundles",
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
        group: "Workflow Bundles",
        cmd: () => setPane("inspector"),
      },
    ],
  }));

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
          Workflow Bundles
        </text>
        <text fg={theme.textMuted}>{`${rows().length} installed`}</text>
      </box>
      <Show
        when={listProblem()}
        fallback={
          <PanelGroup
            axis={stacked() ? "y" : "x"}
            flexGrow={1}
            overflow="hidden"
            gap={1}
          >
            <Panel
              title="Find an installed Bundle"
              focused={pane() === "list"}
              width={stacked() ? undefined : 31}
              height={stacked() ? 9 : undefined}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
              overflow="hidden"
            >
              <input
                focused={pane() === "list"}
                value={query()}
                onInput={updateQuery}
                placeholder="name, id, description, or origin"
                placeholderColor={theme.textMuted}
                cursorColor={theme.accent}
                focusedBackgroundColor={theme.backgroundElement}
                focusedTextColor={theme.text}
              />
              <Show
                when={matching().length > 0}
                fallback={<NoMatches emptyCatalog={rows().length === 0} />}
              >
                <box flexDirection="column" flexGrow={1} overflow="hidden">
                  <For each={matching()}>
                    {(entry) => (
                      <ResultRow
                        bundle={entry.bundle}
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
                    Clear or change the search to inspect an Installed Bundle.
                  </text>
                }
              >
                {(result) => (
                  <Show
                    when={foundBundle(result())}
                    fallback={
                      <text fg={theme.textMuted} paddingLeft={1}>
                        {notFoundExplanation(result()) ?? "No Bundle selected"}
                      </text>
                    }
                  >
                    {(bundle) => (
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
                        <BundleCatalogInspector bundle={bundle()} />
                      </scrollbox>
                    )}
                  </Show>
                )}
              </Show>
            </Panel>
          </PanelGroup>
        }
      >
        {(problem) => (
          <box flexDirection="column" flexShrink={0}>
            <text attributes={TextAttributes.BOLD} fg={theme.error}>
              {`Catalog error: ${problem().code}`}
            </text>
            <text fg={theme.textMuted}>{problem().explanation}</text>
            <text fg={theme.textMuted}>{problem().remediation}</text>
          </box>
        )}
      </Show>
      <text fg={theme.textMuted} flexShrink={0}>
        tab/←/→ switch pane · ↑/↓ move or scroll · esc back · ctrl+c quit
      </text>
    </box>
  );
}

function filterBundles(
  bundles: readonly InstalledBundleSummary[],
  query: string,
): readonly {
  readonly bundle: InstalledBundleSummary;
  readonly index: number;
}[] {
  const needle = query.trim().toLocaleLowerCase();
  return bundles
    .map((bundle, index) => ({ bundle, index }))
    .filter(({ bundle }) => {
      if (needle.length === 0) return true;
      return [
        bundle.name,
        bundle.id,
        bundle.description,
        bundle.origin.kind,
        bundle.origin.location,
      ].some((value) => value.toLocaleLowerCase().includes(needle));
    });
}

function foundBundle(
  result: BundleFocusResult,
): InstalledBundleFocus | undefined {
  return result.found ? result.bundle : undefined;
}

function notFoundExplanation(result: BundleFocusResult): string | undefined {
  return result.found ? undefined : result.problem.explanation;
}

function NoMatches(props: { emptyCatalog: boolean }) {
  const { theme } = useTheme();
  return (
    <box flexDirection="column" paddingTop={1} flexShrink={0}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        {props.emptyCatalog
          ? "No installed Workflow Bundles"
          : "No matching Workflow Bundles"}
      </text>
      <text fg={theme.textMuted}>
        {props.emptyCatalog
          ? "Install one with `secant bundle build` or `secant bundle install`."
          : "Try a different name, id, description, or origin."}
      </text>
    </box>
  );
}

function ResultRow(props: {
  bundle: InstalledBundleSummary;
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
        {`${props.selected && props.focused ? "› " : "  "}${props.bundle.name}`}
      </text>
      <text fg={theme.textMuted}>
        {`  ${props.bundle.id}@${props.bundle.version}`}
      </text>
      <text fg={theme.textMuted}>
        {`  ${props.bundle.origin.kind} ${props.bundle.origin.location}`}
      </text>
    </box>
  );
}
