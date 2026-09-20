import { TextAttributes } from "@opentui/core";
import { For, Show, type Accessor } from "solid-js";
import type {
  AnswerHumanGateOffer,
  Problem,
  RunCheckpointView,
  RunView,
} from "../application/projection-port.js";
import { clip } from "./clip.js";
import type { Openable } from "./run-inspection.js";
import type { Theme } from "./vendor/theme.js";

// Pure presentational leaves for the Run Workbench. State, effects, focus, and the
// interleaved key dispatcher stay in run-workbench.tsx; these views receive only
// Accessors and callbacks from that owner.

/** The interactive-agent human input (#122): a label, a native OpenTUI text field
 *  (D9 — the field draws its own caret), and a hint/status line — a Turn in progress,
 *  the Enter/End Step controls at a boundary, or the End Step confirm. Every line is
 *  plain text so interactive Turns read distinctly from an agent's without colour
 *  (AC2). The field is blurred while an answer is in flight and while the End Step
 *  confirm is armed, so a confirming `y` never types into it (D9 freeze). */
export function InteractiveInput(props: {
  draft: Accessor<string>;
  onInput: (value: string) => void;
  turnLive: Accessor<boolean>;
  endOffered: Accessor<boolean>;
  sendOffered: Accessor<boolean>;
  endArmed: Accessor<boolean>;
  pending: Accessor<boolean>;
  refusal: Accessor<Problem | undefined>;
  focused: Accessor<boolean>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  // Blur the field while an answer is in flight or a confirming keypress is armed, so
  // the submit/`y` never types (D9). The region can still read as focused (its label).
  const fieldFocused = () =>
    props.focused() && !props.pending() && !props.endArmed();
  const hint = () => {
    if (props.endArmed())
      return "  ⚠ End this interactive Step? Press y to confirm · esc to keep";
    if (props.pending()) return "  … sending…";
    if (props.turnLive()) return "  … a Turn is running — interrupt it to stop";
    if (props.sendOffered())
      return "  enter send Turn · ^E end step · esc back";
    return "  esc back";
  };
  return (
    <box flexDirection="column" flexShrink={0}>
      <text
        fg={props.focused() ? theme.text : theme.textMuted}
        attributes={props.focused() ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip("◇ Your Turn — you are driving this Session", w())}
      </text>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.text} flexShrink={0}>
          {"> "}
        </text>
        <input
          value={props.draft()}
          onInput={props.onInput}
          focused={fieldFocused()}
          width={Math.max(1, w() - 2)}
        />
      </box>
      <Show
        when={props.refusal()}
        fallback={
          <text fg={theme.textMuted} flexShrink={0}>
            {clip(hint(), w())}
          </text>
        }
      >
        {(problem) => (
          <text fg={theme.error} flexShrink={0}>
            {clip(`  ✗ ${problem().explanation}`, w())}
          </text>
        )}
      </Show>
    </box>
  );
}

/** The Steer compose input (#148): a label, a native OpenTUI text field (D9 — the
 *  field draws its own caret), and a hint/status line. Same-Turn guidance goes to the
 *  running agent without ending the Turn. Every line is plain text so it reads
 *  distinctly without colour (AC4). The field is blurred while a send is in flight so
 *  a submitting Enter never types into it (D9 freeze). */
export function SteerInput(props: {
  draft: Accessor<string>;
  onInput: (value: string) => void;
  pending: Accessor<boolean>;
  refusal: Accessor<Problem | undefined>;
  focused: Accessor<boolean>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const fieldFocused = () => props.focused() && !props.pending();
  const hint = () => {
    if (props.pending()) return "  … steering…";
    return "  enter send guidance · esc back — the Turn keeps running";
  };
  return (
    <box flexDirection="column" flexShrink={0}>
      <text
        fg={props.focused() ? theme.text : theme.textMuted}
        attributes={props.focused() ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip("➤ Steer — guide the running Turn", w())}
      </text>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.text} flexShrink={0}>
          {"> "}
        </text>
        <input
          value={props.draft()}
          onInput={props.onInput}
          focused={fieldFocused()}
          width={Math.max(1, w() - 2)}
        />
      </box>
      <Show
        when={props.refusal()}
        fallback={
          <text fg={theme.textMuted} flexShrink={0}>
            {clip(hint(), w())}
          </text>
        }
      >
        {(problem) => (
          <text fg={theme.error} flexShrink={0}>
            {clip(`  ✗ ${problem().explanation}`, w())}
          </text>
        )}
      </Show>
    </box>
  );
}

/** The Review checkpoint interaction (#92): the authored message and cadence, the
 *  completed-iteration count, the latest `fail` Verdict, the openable evidence,
 *  and two consequence-stating controls. It replaces the footer while blocked;
 *  every line is plain text so both consequences read with colour removed. */
export function CheckpointInteraction(props: {
  checkpoint: Accessor<RunCheckpointView>;
  height: number;
  offer: Accessor<AnswerHumanGateOffer | undefined>;
  evidence: Accessor<readonly string[]>;
  control: Accessor<"continue" | "stop">;
  focused: Accessor<boolean>;
  pending: Accessor<boolean>;
  refusal: Accessor<Problem | undefined>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const cp = () => props.checkpoint();
  const continueLabel = () => `Continue ${cp().interval} More Iterations`;
  const marker = (which: "continue" | "stop") =>
    props.focused() && props.control() === which ? "› " : "  ";
  const evidence = () => {
    const labels = props.evidence();
    return labels.length > 0 ? labels.join(" · ") : "(none)";
  };
  const status = () => {
    if (props.pending()) return "… submitting your answer";
    const refusal = props.refusal();
    if (refusal !== undefined)
      return `refused: ${refusal.explanation} ${refusal.remediation}`;
    return "←/→ choose · enter confirm · tab timeline · esc back · q quit";
  };
  return (
    <box
      flexDirection="column"
      height={props.height}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <text
        fg={props.focused() ? theme.warning : theme.textMuted}
        attributes={props.focused() ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(
          `${props.focused() ? "› " : "  "}Review checkpoint · every ${cp().interval} iteration(s) · ${cp().completedIterations} completed`,
          w(),
        )}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(
          `  latest: ${cp().latestVerdict.name} = ${cp().latestVerdict.value} · evidence: ${evidence()}`,
          w(),
        )}
      </text>
      <text
        fg={theme.text}
        attributes={props.control() === "continue" ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(
          `${marker("continue")}[ ${continueLabel()} ]${props.pending() ? "  (unavailable)" : ""}`,
          w(),
        )}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`    ${props.offer()?.continueConsequence ?? ""}`, w())}
      </text>
      <text
        fg={theme.text}
        attributes={props.control() === "stop" ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(
          `${marker("stop")}[ Stop Run ]${props.pending() ? "  (unavailable)" : ""}`,
          w(),
        )}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`    ${props.offer()?.stopConsequence ?? ""}`, w())}
      </text>
      <text
        fg={props.refusal() !== undefined ? theme.error : theme.textMuted}
        flexShrink={0}
      >
        {clip(status(), w())}
      </text>
    </box>
  );
}

export function DetailsPanel(props: {
  run: Accessor<RunView>;
  position: Accessor<string>;
  height: number;
  width: Accessor<number>;
  focused: Accessor<boolean>;
  openables: Accessor<readonly Openable[]>;
  selected: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const run = props.run;
  const w = () => props.width();
  return (
    <box
      flexDirection="column"
      height={props.height}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <text
        fg={props.focused() ? theme.text : theme.textMuted}
        attributes={props.focused() ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(`${props.focused() ? "› " : "  "}Details`, w())}
      </text>
      <text fg={theme.text} flexShrink={0}>
        {clip(
          `  ${run().bundle.id}@${run().bundle.version} · sha256:${run().bundle.digest}`,
          w(),
        )}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`  Workspace: ${run().workspacePath}`, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`  Launched: ${run().launchedAt} · ${props.position()}`, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip("  Resources:", w())}
      </text>
      <Show
        when={props.openables().length > 0}
        fallback={
          <text fg={theme.textMuted} flexShrink={0}>
            {clip("    (none)", w())}
          </text>
        }
      >
        <For each={props.openables()}>
          {(openable, index) => (
            <text
              fg={theme.text}
              attributes={
                props.focused() && index() === props.selected()
                  ? TextAttributes.BOLD
                  : 0
              }
              flexShrink={0}
            >
              {clip(
                `    ${props.focused() && index() === props.selected() ? "› " : "  "}${openable.label}`,
                w(),
              )}
            </text>
          )}
        </For>
      </Show>
    </box>
  );
}
