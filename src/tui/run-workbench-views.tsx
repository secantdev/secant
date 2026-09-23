import { TextAttributes } from "@opentui/core";
import { For, Show, type Accessor } from "solid-js";
import type {
  AnswerHumanGateOffer,
  CancelRunOffer,
  ContinueRepeatOffer,
  DeleteRunOffer,
  InterruptTurnOffer,
  Problem,
  RunCheckpointView,
  RunStateName,
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
  interrupt: Accessor<InterruptTurnOffer | undefined>;
  interruptArmed: Accessor<boolean>;
  endOffered: Accessor<boolean>;
  sendOffered: Accessor<boolean>;
  endArmed: Accessor<boolean>;
  continueOffer: Accessor<ContinueRepeatOffer | undefined>;
  continueArmed: Accessor<boolean>;
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
    props.focused() &&
    !props.pending() &&
    !props.endArmed() &&
    !props.continueArmed();
  const hint = () => {
    if (props.endArmed())
      return "  ⚠ End this interactive Step? Press y to confirm · esc to keep";
    // The confirm leads with its keys so a narrow clip keeps them (#217).
    const continueOffer = props.continueOffer();
    if (props.continueArmed() && continueOffer !== undefined)
      return `  ⚠ y continue · esc keep — ${continueOffer.consequence}`;
    if (props.pending()) return "  … sending…";
    if (props.turnLive()) {
      // The live Turn's Interrupt (#219) leads with its key so a narrow clip keeps it.
      const interrupt = props.interrupt();
      if (interrupt === undefined) return "  … a Turn is running";
      return props.interruptArmed()
        ? "  ⚠ Press esc again to interrupt · any other key cancels"
        : `  esc esc interrupt — ${interrupt.consequence}`;
    }
    if (props.sendOffered())
      return continueOffer !== undefined
        ? "  enter send Turn · ^N continue · esc back"
        : "  enter send Turn · ^E end step · esc back";
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

/** Short prose stating why a resting Run rests (#194 story 38), derived purely in
 *  presentation from the Run view's `state` and — for `halted`/`blocked` — the
 *  conflict/checkpoint/gate facts. Exhaustive over `RunStateName` so a new state
 *  must be given prose here to compile. `running` is not a resting state. Both the
 *  header (beside the state word, so colour is never the only signal, AC4) and the
 *  panel's recovery evidence (AC2) render this one string. */
export function restingProse(run: RunView): string | undefined {
  switch (run.state) {
    case "running":
      return undefined;
    case "succeeded":
      return "Workflow completed.";
    case "failed":
      return "This Run has ended.";
    case "cancelled":
      return "You cancelled this Run.";
    case "halted":
      return run.conflict !== undefined
        ? "A required file changed, so execution stopped outside the Workflow."
        : "Execution stopped outside the Workflow.";
    case "blocked":
      return run.checkpoint !== undefined
        ? "You stopped at the Review checkpoint."
        : run.pendingGate !== undefined
          ? "Paused at a Human Gate — waiting for your answer."
          : "It's your Turn — waiting for you to continue.";
  }
}

export type DetailsTone = "text" | "muted" | "warning" | "error" | "success";

export interface DetailsRow {
  readonly text: string;
  readonly tone: DetailsTone;
  readonly bold: boolean;
}

function restingTone(state: RunStateName): DetailsTone {
  switch (state) {
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    case "halted":
    case "blocked":
      return "warning";
    case "cancelled":
    case "running":
      return "muted";
  }
}

/** The details panel's rows, built once so the render and the container's exact
 *  row reservation (the panel's height) share one source of truth (tui/AGENTS.md).
 *  Every recovery-evidence line appears only when the Run view exposes its fact —
 *  nothing is invented when a fact is absent (#194 story 36, AC2). */
export function buildDetailsRows(params: {
  readonly run: RunView;
  readonly position: string;
  readonly compact: boolean;
  readonly focused: boolean;
  readonly openables: readonly Openable[];
  readonly selected: number;
  /** Set when the resting resume offer arms an indeterminate-Command-Attempt
   *  acknowledgement (#194 story 39); surfaced as recovery evidence too. */
  readonly resumeAcknowledgement: string | undefined;
  readonly cancel: CancelRunOffer | undefined;
  readonly remove: DeleteRunOffer | undefined;
  readonly armed: "cancel" | "delete" | undefined;
}): DetailsRow[] {
  const { run } = params;
  const rows: DetailsRow[] = [];
  const push = (text: string, tone: DetailsTone = "muted", bold = false) =>
    rows.push({ text, tone, bold });

  push(`${params.focused ? "› " : "  "}Details`, "text", params.focused);
  push(
    `  ${run.bundle.id}@${run.bundle.version} · sha256:${run.bundle.digest}`,
    "text",
  );
  push(`  Workspace: ${run.workspacePath}`);
  push(`  Launched: ${run.launchedAt} · ${params.position}`);

  // Harness/model facts, moved out of the header (#194 story 35): durable
  // selection, then the latest Attempt's observation, then the requested model
  // kept visibly apart from the observed effective model (AC1). The compact form
  // drops the long executable path to stay readable at small widths.
  if (run.selectedHarness !== undefined)
    push(`  Selected Harness · ${run.selectedHarness}`);
  if (run.harness !== undefined) {
    const model = run.effectiveModel ?? "not reported";
    push(
      params.compact
        ? `  Observed Harness · ${run.harness.name} · ${run.harness.executableVersion} · model ${model}`
        : `  Observed Harness · ${run.harness.name} · ${run.harness.executable} · ${run.harness.executableVersion} · model ${model}`,
    );
  }
  if (run.requestedModel !== undefined)
    push(`  Requested model · ${run.requestedModel}`);

  // Recovery evidence (#194 story 36): each line only when its fact is present.
  const recovery: DetailsRow[] = [];
  const prose = restingProse(run);
  if (prose !== undefined)
    recovery.push({
      text: `  Resting reason · ${prose}`,
      tone: restingTone(run.state),
      bold: false,
    });
  const last = run.timeline[run.timeline.length - 1];
  if (last !== undefined)
    recovery.push({
      text: `  Latest activity · ${last.event}${last.detail !== undefined ? ` ${last.detail}` : ""} · ${last.at}`,
      tone: "muted",
      bold: false,
    });
  if (run.conflict !== undefined)
    recovery.push({
      text: `  Materialization conflict · restore ${run.conflict.path}`,
      tone: "warning",
      bold: false,
    });
  if (params.resumeAcknowledgement !== undefined)
    recovery.push({
      text: `  Indeterminate Attempt · ${params.resumeAcknowledgement}`,
      tone: "warning",
      bold: false,
    });
  for (const session of run.sessions ?? [])
    recovery.push({
      text: `  Session ${session.session} · ${session.availability}`,
      tone: session.availability === "unusable" ? "warning" : "muted",
      bold: false,
    });
  if (recovery.length > 0) {
    push("  Recovery:", "muted");
    rows.push(...recovery);
  }

  push("  Resources:", "muted");
  if (params.openables.length === 0) push("    (none)");
  else
    params.openables.forEach((openable, index) => {
      const active = params.focused && index === params.selected;
      push(`    ${active ? "› " : "  "}${openable.label}`, "text", active);
    });

  // Secondary lifecycle actions, moved off the main rail (#194 story 37): cancel
  // and delete render here with the consequence each Offer names, and their
  // confirm-armed prompt (AC3) shows in place while armed.
  if (params.cancel !== undefined || params.remove !== undefined) {
    push("  Actions:", "muted");
    if (params.cancel !== undefined)
      push(`    c cancel — ${params.cancel.consequence}`, "text");
    if (params.remove !== undefined)
      push(`    x delete — ${params.remove.consequence}`, "text");
    if (params.armed === "cancel")
      push(
        "    ⚠ Cancel ends the Run (history is kept). Press y to confirm · esc to keep",
        "warning",
      );
    else if (params.armed === "delete")
      push(
        "    ⚠ Delete is permanent (Workspace files are kept). Press y to confirm · esc to keep",
        "warning",
      );
  }

  return rows;
}

export function DetailsPanel(props: {
  rows: Accessor<readonly DetailsRow[]>;
  height: number;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const colour = (tone: DetailsTone) =>
    tone === "text"
      ? theme.text
      : tone === "warning"
        ? theme.warning
        : tone === "error"
          ? theme.error
          : tone === "success"
            ? theme.success
            : theme.textMuted;
  return (
    <box
      flexDirection="column"
      height={props.height}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <For each={props.rows()}>
        {(row) => (
          <text
            fg={colour(row.tone)}
            attributes={row.bold ? TextAttributes.BOLD : 0}
            flexShrink={0}
          >
            {clip(row.text, w())}
          </text>
        )}
      </For>
    </box>
  );
}
