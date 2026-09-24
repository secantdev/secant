import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, For, Show, type Accessor } from "solid-js";
import type {
  BundleFocusResult,
  InstalledBundleFocus,
  InstalledBundleSummary,
} from "../application/projection-port.js";
import { BundleCatalogInspector } from "./bundle-catalog-inspector.js";
import { useBundleCatalogView } from "./bundle-view.js";
import {
  CatalogEmptyState,
  CatalogRow,
  useCatalogNavigation,
} from "./catalog-navigation.js";
import { Panel, PanelGroup } from "./vendor/panels.js";
import { useTheme } from "./vendor/theme-context.js";
import { formatOrigin } from "./bundle-format.js";

// One read-only Workflow Bundles catalog over the existing list/focus
// Projections. Its two-pane shape is reduced from OpenCode's diff viewer and its
// selection/search shape from dialog-select.tsx at 1ead9e3d7f (see UPSTREAM),
// now shared with the Harness catalog through catalog-navigation.tsx.
// Secant keeps substring search presentation-only, exposes no Action Offers,
// marks focus in words/glyphs, stacks at a small width, and clamps scrolling.

const STACK_BREAKPOINT = 70;

export function BundleCatalog(props: {
  selected: Accessor<number>;
  setSelected: (index: number) => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const dimensions = useTerminalDimensions();
  const view = useBundleCatalogView();
  const snapshot = view.openList();
  let inspectorScroll: ScrollBoxRenderable | undefined;

  const rows = () => {
    const result = snapshot().result;
    return result.found ? result.bundles : [];
  };
  const listProblem = () => {
    const result = snapshot().result;
    return result.found ? undefined : result.problem;
  };
  const { query, pane, matching, activeEntry, updateQuery } =
    useCatalogNavigation({
      filter: (value) => filterBundles(rows(), value),
      selected: props.selected,
      setSelected: props.setSelected,
      onBack: props.onBack,
      group: "Workflow Bundles",
      item: "Bundle",
      inspector: () => inspectorScroll,
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
                fallback={
                  <CatalogEmptyState
                    title={
                      rows().length === 0
                        ? "No installed Workflow Bundles"
                        : "No matching Workflow Bundles"
                    }
                    hint={
                      rows().length === 0
                        ? "Install one with `secant bundle build` or `secant bundle install`."
                        : "Try a different name, id, description, or origin."
                    }
                  />
                }
              >
                <box flexDirection="column" flexGrow={1} overflow="hidden">
                  <For each={matching()}>
                    {(entry) => (
                      <CatalogRow
                        title={entry.bundle.name}
                        details={[
                          `${entry.bundle.id}@${entry.bundle.version}`,
                          formatOrigin(
                            entry.bundle.origin,
                            entry.bundle.shippedWithRunningSecant,
                          ),
                        ]}
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
        formatOrigin(bundle.origin),
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
