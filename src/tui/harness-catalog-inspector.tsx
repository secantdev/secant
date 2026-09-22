import { TextAttributes } from "@opentui/core";
import { For, Show, type Accessor, type JSX } from "solid-js";
import type {
  HarnessCapabilityView,
  HarnessFocus,
} from "../application/projection-port.js";
import {
  capabilityLabel,
  discoveryLabel,
  qualificationLabel,
  qualificationObservation,
} from "./harness-format.js";
import { useTheme } from "./vendor/theme-context.js";

export function HarnessCatalogInspector(props: {
  harness: Accessor<HarnessFocus>;
}) {
  const { theme } = useTheme();
  const harness = props.harness;
  const observation = () => qualificationObservation(harness().qualification);
  const checkedAt = () => {
    const qualification = harness().qualification;
    return qualification.state === "not-checked"
      ? "Not checked"
      : qualification.state === "not-ready"
        ? qualification.checkedAt
        : qualification.observation.checkedAt;
  };
  const authentication = () =>
    harness().authenticationInstructions ??
    (observation() === undefined ? "Not checked" : "Ready");

  return (
    <box flexDirection="column" gap={1} flexShrink={0}>
      <box flexDirection="column" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {`${harness().name} · ${qualificationLabel(harness().qualification.state)}`}
        </text>
        <text fg={theme.textMuted}>
          {`Discovery · ${discoveryLabel(harness().discovery)}`}
        </text>
      </box>
      <Show when={harness().unavailable}>
        {(problem) => (
          <box flexDirection="column" flexShrink={0}>
            <text
              fg={theme.error}
            >{`Unavailable · ${problem().explanation}`}</text>
            <text
              fg={theme.textMuted}
            >{`Remediation · ${problem().remediation}`}</text>
          </box>
        )}
      </Show>
      <box flexDirection="column" flexShrink={0}>
        <Fact label="Harness" value={harness().id} />
        <Fact
          label="Executable"
          value={observation()?.executable ?? "Not available"}
        />
        <Fact
          label="Version"
          value={observation()?.executableVersion ?? "Not available"}
        />
        <Fact
          label="Platform"
          value={observation()?.platform ?? "Not available"}
        />
        <Fact label="Checked" value={checkedAt()} />
        <Fact label="Authentication" value={authentication()} />
      </box>
      <Section title="Supported models">
        <SupportedModels harness={harness} />
      </Section>
      <Section title="Capabilities">
        <For each={harness().capabilities}>
          {(capability) => <Capability capability={capability} />}
        </For>
      </Section>
      <Section title="Configuration">
        <text fg={theme.text}>
          {harness().configurationPosture ?? "Not checked"}
        </text>
        <text fg={theme.textMuted}>
          Harness-owned settings stay with the Harness. Secant asks only for
          relevant Run choices during launch or resume.
        </text>
      </Section>
    </box>
  );
}

function Fact(props: { label: string; value: string }) {
  const { theme } = useTheme();
  return <text fg={theme.text}>{`${props.label} · ${props.value}`}</text>;
}

function Section(props: { title: string; children: JSX.Element }) {
  const { theme } = useTheme();
  return (
    <box flexDirection="column" flexShrink={0}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        {props.title}
      </text>
      {props.children}
    </box>
  );
}

function SupportedModels(props: { harness: Accessor<HarnessFocus> }) {
  const { theme } = useTheme();
  const models = () => props.harness().supportedModels;
  const listedModels = () => {
    const declaration = models();
    return declaration?.kind === "list" ? declaration.models : undefined;
  };
  return (
    <Show
      when={listedModels()}
      fallback={
        <text
          fg={models()?.kind === "free-text" ? theme.text : theme.textMuted}
        >
          {models()?.kind === "free-text"
            ? "Free-text model entry"
            : "Models not available yet"}
        </text>
      }
    >
      {(models) => (
        <For each={models()}>
          {(model) => (
            <text fg={theme.text}>
              {`${model} · Available for Run selection`}
            </text>
          )}
        </For>
      )}
    </Show>
  );
}

function Capability(props: { capability: HarnessCapabilityView }) {
  const { theme } = useTheme();
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.text}>
        {`${props.capability.name} · ${capabilityLabel(props.capability.state)}`}
      </text>
      <text fg={theme.textMuted}>{props.capability.description}</text>
      <Show
        when={
          props.capability.state === "available-with-limits"
            ? props.capability.limits
            : undefined
        }
      >
        {(limits) => <text fg={theme.textMuted}>{`Limits · ${limits()}`}</text>}
      </Show>
    </box>
  );
}
