import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, Show, type ParentProps } from "solid-js";
import type {
  BundleFocusResult,
  BundleFocusSelector,
  ExecutionSummary,
  InstalledBundleFocus,
  RoutingNodeView,
} from "../application/projection-port.js";
import { formatEngine, formatTrust } from "./bundle-format.js";
import { useBundleCatalogView } from "./bundle-view.js";
import { useBindings } from "./keymap.js";
import { useExit } from "./vendor/exit.js";
import { useTheme } from "./vendor/theme-context.js";

// The Bundle inspection screen: exact focus of one Installed Bundle. Rebuilt
// against OpenCode's full-route detail view
// (packages/tui/src/feature-plugins/system/diff-viewer.tsx at commit 1ead9e3d7f,
// see UPSTREAM "REBUILT AGAINST"). Taken: a full-size route box and Escape =
// navigate back to the screen you came from. Changed: no scrollbox and no
// split/pane focus model — large content and the timeline are M2 (#57), so this
// is a plain top-to-bottom render of the focus Projection; the fields and their
// wording match the headless `bundle inspect` (headless.ts renderFocus) so both
// clients show exactly the same facts, with severity/stability/trust readable
// without colour. The quit binding works here too.

// Narrowing helpers: the Show `when` has already decided which arm applies, but
// the union does not survive into the child, so each helper asserts the arm.
function foundBundle(result: BundleFocusResult): InstalledBundleFocus {
  if (!result.found) throw new Error("expected a found Bundle focus");
  return result.bundle;
}
function notFoundProblem(result: BundleFocusResult): string | undefined {
  return result.found ? undefined : result.problem.explanation;
}

export function BundleInspect(props: {
  selector: BundleFocusSelector;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dimensions = useTerminalDimensions();
  const view = useBundleCatalogView();
  const snapshot = view.openFocus(props.selector);

  useBindings(() => ({
    bindings: [
      { key: "escape", desc: "Back", group: "Bundle", cmd: props.onBack },
      { key: "q", desc: "Quit", group: "Bundle", cmd: () => exit() },
      { key: "ctrl+c", desc: "Quit", group: "Bundle", cmd: () => exit() },
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
      <Show
        when={snapshot().result.found}
        fallback={
          <NotFound
            selector={props.selector}
            problem={notFoundProblem(snapshot().result)}
          />
        }
      >
        <Focus bundle={foundBundle(snapshot().result)} />
      </Show>
      <text fg={theme.textMuted}>esc back · q quit</text>
    </box>
  );
}

function NotFound(props: {
  selector: BundleFocusSelector;
  problem: string | undefined;
}) {
  const { theme } = useTheme();
  const label = () =>
    props.selector.version
      ? `${props.selector.id}@${props.selector.version}`
      : props.selector.id;
  return (
    <box flexDirection="column">
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        {`Not found: ${label()}`}
      </text>
      <Show when={props.problem}>
        <text fg={theme.textMuted}>{props.problem}</text>
      </Show>
    </box>
  );
}

function Label(props: ParentProps) {
  const { theme } = useTheme();
  return <text fg={theme.textMuted}>{props.children}</text>;
}

// Each `<text>` carries a single concatenated string: OpenTUI lays out multiple
// children as separate inline spans, which garbles a line, so every line is
// built as one string here.
function Focus(props: { bundle: InstalledBundleFocus }) {
  const { theme } = useTheme();
  const b = () => props.bundle;
  const author = () => b().author;
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {b().name}
        </text>
        <text fg={theme.text}>
          {`${b().id}@${b().version} [${b().stability}]`}
        </text>
        <text fg={theme.textMuted}>{b().description}</text>
      </box>

      <box flexDirection="column">
        <text fg={theme.text}>{`digest: sha256:${b().digest}`}</text>
        <text fg={theme.text}>
          {`origin: ${b().origin.kind} ${b().origin.location}`}
        </text>
        <text fg={theme.text}>{`platforms: ${b().platforms.join(", ")}`}</text>
        <text fg={theme.text}>{`engine: ${formatEngine(b().engine)}`}</text>
        <text fg={theme.text}>{`trust: ${formatTrust(b().trust)}`}</text>
      </box>

      <Show
        when={
          author().authors?.length ||
          author().license !== undefined ||
          author().homepage !== undefined ||
          author().repository !== undefined ||
          author().keywords?.length ||
          author().notices?.length
        }
      >
        <box flexDirection="column">
          <Label>Author</Label>
          <Show when={author().authors?.length}>
            <text fg={theme.text}>
              {`authors: ${author().authors!.join(", ")}`}
            </text>
          </Show>
          <Show when={author().license !== undefined}>
            <text fg={theme.text}>{`license: ${author().license}`}</text>
          </Show>
          <Show when={author().homepage !== undefined}>
            <text fg={theme.text}>{`homepage: ${author().homepage}`}</text>
          </Show>
          <Show when={author().repository !== undefined}>
            <text fg={theme.text}>{`repository: ${author().repository}`}</text>
          </Show>
          <Show when={author().keywords?.length}>
            <text fg={theme.text}>
              {`keywords: ${author().keywords!.join(", ")}`}
            </text>
          </Show>
          <Show when={author().notices?.length}>
            <text fg={theme.text}>
              {`notices: ${author().notices!.join(", ")}`}
            </text>
          </Show>
        </box>
      </Show>

      <box flexDirection="column">
        <Label>Launch inputs</Label>
        <Show
          when={b().launchInputs.length > 0}
          fallback={<text fg={theme.textMuted}>(none)</text>}
        >
          <For each={b().launchInputs}>
            {(input) => (
              <text fg={theme.text}>
                {`${input.name} (${input.type})${
                  input.schema !== undefined ? ` schema=${input.schema}` : ""
                }${
                  input.choices ? ` choices=[${input.choices.join(", ")}]` : ""
                }: ${input.description}`}
              </text>
            )}
          </For>
        </Show>
      </box>

      <box flexDirection="column">
        <Label>Routing</Label>
        <For each={b().routing}>{(node) => <RoutingNode node={node} />}</For>
      </box>

      <box flexDirection="column">
        <Label>Workspace prerequisites</Label>
        <text fg={theme.text}>
          {b().workspacePrerequisites.length === 0
            ? "(none)"
            : b().workspacePrerequisites.join(", ")}
        </text>
      </box>

      <box flexDirection="column">
        <Label>Produced artifacts</Label>
        <Show
          when={b().producedArtifacts.length > 0}
          fallback={<text fg={theme.textMuted}>(none)</text>}
        >
          <For each={b().producedArtifacts}>
            {(produced) => (
              <text fg={theme.text}>
                {`${produced.name} (${produced.type}) home=${produced.home}${
                  produced.path !== undefined ? ` path=${produced.path}` : ""
                } from ${produced.producedBy}`}
              </text>
            )}
          </For>
        </Show>
      </box>

      <Execution summary={b().executionSummary} />

      <box flexDirection="column">
        <Label>Composition findings</Label>
        <Show
          when={b().compositionFindings.length > 0}
          fallback={<text fg={theme.success}>none (0 errors)</text>}
        >
          <For each={b().compositionFindings}>
            {(finding) => (
              <text
                fg={finding.severity === "error" ? theme.error : theme.warning}
              >
                {`[${finding.severity}] ${finding.code} @ ${finding.target}: ${finding.explanation}`}
              </text>
            )}
          </For>
        </Show>
      </box>
    </box>
  );
}

function RoutingNode(props: { node: RoutingNodeView }) {
  const { theme } = useTheme();
  const node = props.node;
  if (node.node === "step") {
    return <text fg={theme.text}>{`${node.step.id} (${node.step.kind})`}</text>;
  }
  return (
    <box flexDirection="column">
      <text fg={theme.text}>
        {`repeat until ${node.until} (review every ${node.reviewCheckpoint.interval}: ${node.reviewCheckpoint.message})`}
      </text>
      <For each={node.steps}>
        {(step) => <text fg={theme.text}>{`  ${step.id} (${step.kind})`}</text>}
      </For>
    </box>
  );
}

function Execution(props: { summary: ExecutionSummary }) {
  const { theme } = useTheme();
  const s = () => props.summary;
  const counts = () =>
    Object.entries(s().stepKindCounts)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", ") || "(none)";
  return (
    <box flexDirection="column">
      <Label>{`Execution summary (platform ${props.summary.platform})`}</Label>
      <text fg={theme.text}>{`step-kind counts: ${counts()}`}</text>
      <Show
        when={s().commands.length > 0}
        fallback={<text fg={theme.text}>commands: (none)</text>}
      >
        <text fg={theme.text}>commands:</text>
        <For each={s().commands}>
          {(command) => (
            <text fg={theme.text}>
              {`  ${command.stepId}: ${command.executable}${
                command.workingDirectory !== undefined
                  ? ` cwd=${command.workingDirectory}`
                  : ""
              }${
                command.environmentVariableNames.length > 0
                  ? ` env=[${command.environmentVariableNames.join(", ")}]`
                  : ""
              }${
                command.scripts.length > 0
                  ? ` scripts=[${command.scripts.join(", ")}]`
                  : ""
              }`}
            </text>
          )}
        </For>
      </Show>
      <text fg={theme.warning}>{`warning: ${s().warning}`}</text>
    </box>
  );
}
