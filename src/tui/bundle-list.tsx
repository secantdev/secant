import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, Show, type Accessor } from "solid-js";
import type {
  BundleFocusSelector,
  InstalledBundleSummary,
} from "../application/projection-port.js";
import { formatEngine, formatTrust } from "./bundle-format.js";
import { useBundleCatalogView } from "./bundle-view.js";
import { useBindings } from "./keymap.js";
import { useExit } from "./vendor/exit.js";
import { useTheme } from "./vendor/theme-context.js";

// The Workflow Bundles list screen, rebuilt against OpenCode
// packages/tui/src/ui/dialog-select.tsx at commit 1ead9e3d7f (see UPSTREAM
// "REBUILT AGAINST"). Taken: the selection model (a single active index moved by
// up/down, Return opens the active row) and the active-row highlight (background
// + bold). Changed: OpenCode glyph-marks only the *current* value, not the
// focused row — here the focused row carries a leading "› " glyph AND the
// highlight so focus reads without colour (ADR 0024 / #19); movement clamps at
// the ends rather than wrapping; OpenCode's fuzzy-filter/group/flat option store
// collapses to the `bundle-catalog` list Projection read through the Port, never
// OpenCode's data; the empty state names the headless install commands. Escape
// returns to Home; the quit binding works here too. No Action Offers: the family
// is read-only (#9). Scroll is deferred: large content is M2 (#57), so no
// scrollbox is vendored yet.

export function BundleList(props: {
  selected: Accessor<number>;
  setSelected: (index: number) => void;
  onOpen: (selector: BundleFocusSelector) => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dimensions = useTerminalDimensions();
  const view = useBundleCatalogView();
  const snapshot = view.openList();
  // The list resolves to rows or a Problem when a listed Bundle's bytes are gone
  // (#74 A3); an unresolved list has no rows to select.
  const bundles = () => {
    const result = snapshot().result;
    return result.found ? result.bundles : [];
  };
  const listProblem = () => {
    const result = snapshot().result;
    return result.found ? undefined : result.problem;
  };

  // The active index, always clamped to the current list so a shorter list (or
  // an empty one) never selects past the end.
  const active = () => Math.min(props.selected(), bundles().length - 1);
  const move = (delta: number) => {
    const count = bundles().length;
    if (count === 0) return;
    props.setSelected(Math.max(0, Math.min(active() + delta, count - 1)));
  };

  useBindings(() => ({
    bindings: [
      { key: "up", desc: "Previous", group: "Bundles", cmd: () => move(-1) },
      { key: "down", desc: "Next", group: "Bundles", cmd: () => move(1) },
      {
        key: "return",
        desc: "Inspect",
        group: "Bundles",
        cmd: () => {
          const bundle = bundles()[active()];
          if (bundle) props.onOpen({ id: bundle.id, version: bundle.version });
        },
      },
      { key: "escape", desc: "Back", group: "Bundles", cmd: props.onBack },
      { key: "q", desc: "Quit", group: "Bundles", cmd: () => exit() },
      { key: "ctrl+c", desc: "Quit", group: "Bundles", cmd: () => exit() },
    ],
  }));

  // The container clips overflow rather than shrinking rows: a full row keeps
  // all seven fact lines even when the list is taller than the terminal (scroll
  // for long lists is M2, #57). Each row and the header/footer hold their height
  // with flexShrink={0}.
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
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Workflow Bundles
      </text>
      <Show
        when={listProblem()}
        fallback={
          <Show
            when={bundles().length > 0}
            fallback={
              <box flexDirection="column" flexShrink={0}>
                <text fg={theme.textMuted}>The Catalog is empty.</text>
                <text fg={theme.textMuted}>
                  {"Install one with `secant bundle build <folder>` or"}
                </text>
                <text fg={theme.textMuted}>
                  {"`secant bundle install <file.wfb>`."}
                </text>
              </box>
            }
          >
            <box flexDirection="column" gap={1} flexGrow={1} overflow="hidden">
              <For each={bundles()}>
                {(bundle, index) => (
                  <Row
                    bundle={bundle}
                    selected={index() === active()}
                    onOpen={() =>
                      props.onOpen({ id: bundle.id, version: bundle.version })
                    }
                  />
                )}
              </For>
            </box>
          </Show>
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
        ↑/↓ move · enter inspect · esc back · q quit
      </text>
    </box>
  );
}

function Row(props: {
  bundle: InstalledBundleSummary;
  selected: boolean;
  onOpen: () => void;
}) {
  const { theme } = useTheme();
  const b = () => props.bundle;
  const rowColor = () => (props.selected ? theme.text : theme.textMuted);
  // Each line is a single concatenated string: OpenTUI's `<text>` lays out
  // multiple children as separate inline spans, so a mix of literals and
  // expressions garbles the line — one string per line keeps it flowing.
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={props.selected ? theme.backgroundElement : undefined}
      onMouseUp={props.onOpen}
    >
      <text
        fg={theme.text}
        attributes={props.selected ? TextAttributes.BOLD : 0}
      >
        {`${props.selected ? "› " : "  "}${b().name}`}
      </text>
      <text fg={rowColor()}>
        {`  ${b().id}@${b().version} [${b().stability}]`}
      </text>
      <text fg={rowColor()}>{`  digest: sha256:${b().digest}`}</text>
      <text fg={rowColor()}>
        {`  origin: ${b().origin.kind} ${b().origin.location}`}
      </text>
      <text fg={rowColor()}>{`  platforms: ${b().platforms.join(", ")}`}</text>
      <text fg={rowColor()}>{`  engine: ${formatEngine(b().engine)}`}</text>
      <text fg={rowColor()}>{`  trust: ${formatTrust(b().trust)}`}</text>
    </box>
  );
}
