import { TextAttributes } from "@opentui/core";
import { For, Show, type ParentProps } from "solid-js";
import type {
  ExecutionSummary,
  InstalledBundleFocus,
  RoutingNodeView,
  RoutingStepView,
} from "../application/projection-port.js";
import { formatEngine, formatTrust } from "./bundle-format.js";
import { useTheme } from "./vendor/theme-context.js";

// Pure presentational leaf for the Bundle catalog. The screen owns Projection
// lifecycle, focus, and scrolling; this submodule owns only the exact focused
// Bundle facts and their authored routing shape.

export function BundleCatalogInspector(props: {
  bundle: InstalledBundleFocus;
}) {
  const { theme } = useTheme();
  const bundle = () => props.bundle;
  return (
    <box flexDirection="column" gap={1} flexShrink={0}>
      <box flexDirection="column" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {bundle().name}
        </text>
        <text fg={theme.text}>
          {`${bundle().id}@${bundle().version} [${bundle().stability}]`}
        </text>
        <text fg={theme.textMuted}>{bundle().description}</text>
      </box>
      <box flexDirection="column" flexShrink={0}>
        <Label>Source</Label>
        <text fg={theme.text}>
          {`${bundle().origin.kind} · ${bundle().origin.location}`}
        </text>
        <text fg={theme.text}>
          {`Platforms · ${bundle().platforms.join(", ")}`}
        </text>
        <text
          fg={theme.text}
        >{`Engine · ${formatEngine(bundle().engine)}`}</text>
        <text fg={theme.text}>
          {`Workspace requirements · ${
            bundle().workspacePrerequisites.length === 0
              ? "none"
              : bundle().workspacePrerequisites.join(", ")
          }`}
        </text>
        <text fg={theme.text}>{`Digest · sha256:${bundle().digest}`}</text>
        <text fg={theme.text}>{`Trust · ${formatTrust(bundle().trust)}`}</text>
      </box>
      <box flexDirection="column" flexShrink={0}>
        <Label>Workflow</Label>
        <For each={bundle().routing}>
          {(node, index) => (
            <RoutingNode
              node={node}
              number={index() + 1}
              commands={bundle().executionSummary.commands}
            />
          )}
        </For>
      </box>
      <box flexDirection="column" flexShrink={0}>
        <Label>Launch inputs</Label>
        <Show
          when={bundle().launchInputs.length > 0}
          fallback={
            <box flexDirection="column">
              <text fg={theme.text}>No launch inputs</text>
              <text fg={theme.textMuted}>
                Start a Run proceeds from Harness to Review.
              </text>
            </box>
          }
        >
          <For each={bundle().launchInputs}>
            {(input) => (
              <text fg={theme.text}>
                {`${input.name} (${input.type}): ${input.description}`}
              </text>
            )}
          </For>
        </Show>
      </box>
      <Execution summary={bundle().executionSummary} />
    </box>
  );
}

function Label(props: ParentProps) {
  const { theme } = useTheme();
  return <text fg={theme.textMuted}>{props.children}</text>;
}

function RoutingNode(props: {
  node: RoutingNodeView;
  number: number;
  commands: ExecutionSummary["commands"];
}) {
  const { theme } = useTheme();
  if (props.node.node === "step") {
    return (
      <StepLine
        prefix={`${props.number}.`}
        step={props.node.step}
        commands={props.commands}
      />
    );
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.text}>
        {`${props.number}. Repeat until ${props.node.until} · review every ${props.node.reviewCheckpoint.interval}: ${props.node.reviewCheckpoint.message}`}
      </text>
      <For each={props.node.steps}>
        {(step, index) => (
          <StepLine
            prefix={`   ${props.number}.${index() + 1}.`}
            step={step}
            commands={props.commands}
          />
        )}
      </For>
    </box>
  );
}

function StepLine(props: {
  prefix: string;
  step: RoutingStepView;
  commands: ExecutionSummary["commands"];
}) {
  const { theme } = useTheme();
  const command = () =>
    props.commands.find((entry) => entry.stepId === props.step.id);
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.text}>
        {`${props.prefix} ${props.step.id} (${props.step.kind})`}
      </text>
      <Show when={command()}>
        {(entry) => (
          <text fg={theme.textMuted}>
            {`     $ ${entry().executable}${
              entry().scripts.length > 0
                ? ` · scripts ${entry().scripts.join(", ")}`
                : ""
            }`}
          </text>
        )}
      </Show>
    </box>
  );
}

function Execution(props: { summary: ExecutionSummary }) {
  const { theme } = useTheme();
  const counts = () =>
    Object.entries(props.summary.stepKindCounts)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", ") || "none";
  return (
    <box flexDirection="column" flexShrink={0}>
      <Label>{`Execution summary · ${props.summary.platform}`}</Label>
      <text fg={theme.text}>{`Step kinds · ${counts()}`}</text>
      <Show
        when={props.summary.commands.length > 0}
        fallback={<text fg={theme.text}>Commands · none</text>}
      >
        <text fg={theme.text}>Commands</text>
        <For each={props.summary.commands}>
          {(command) => (
            <text fg={theme.text}>
              {`  ${command.stepId}: ${command.executable}${
                command.workingDirectory !== undefined
                  ? ` · cwd ${command.workingDirectory}`
                  : ""
              }${
                command.environmentVariableNames.length > 0
                  ? ` · env ${command.environmentVariableNames.join(", ")}`
                  : ""
              }${
                command.scripts.length > 0
                  ? ` · scripts ${command.scripts.join(", ")}`
                  : ""
              }`}
            </text>
          )}
        </For>
      </Show>
      <text fg={theme.warning}>{`Warning · ${props.summary.warning}`}</text>
    </box>
  );
}
