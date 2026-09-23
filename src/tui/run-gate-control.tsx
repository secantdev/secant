import { TextAttributes } from "@opentui/core";
import { createMemo, createSignal, Show, type Accessor } from "solid-js";
import type {
  AnswerHumanGateOffer,
  Problem,
  RunGateReference,
  RunView,
} from "../application/projection-port.js";
import { clip } from "./clip.js";
import { followSettlement, onIdentityChange } from "./run-control-effects.js";
import type { AnswerOutcome } from "./run-view.js";
import { useTheme } from "./vendor/theme-context.js";

// The free-text Human Gate control, split out of run-workbench.tsx (A33): its state,
// its self-contained modal key branch, and its view interleave with the rest of the
// Workbench only through the modal-control gate — the same seam the reference-inspection
// overlay was split on (run-inspection.tsx). The controller owns everything about
// answering the gate; the Workbench asks it whether a gate is up (to gate the Actions
// rail and the Esc interrupt) and hands it keys while it is. Code moved verbatim from
// run-workbench.tsx.

type Theme = ReturnType<typeof useTheme>["theme"];

/** Rows the free-text Human Gate control occupies while it replaces the footer
 *  (#121, spec story 17): the gate message, the declared output name, the text
 *  entry line, and a status/hint line — plus the suggestion row when the gate
 *  authored suggestions (#213). */
export function gateHeight(gate: FreeTextGate): number {
  return gate.suggestions.length > 0 ? 5 : 4;
}

/** An empty free-text answer is refused in the client before any dispatch (#121
 *  AC3): the Port would accept `text: ""`, but the Workbench never sends a blank. */
const EMPTY_GATE_ANSWER: Problem = {
  code: "gate-answer-empty",
  explanation: "A free-text answer cannot be empty.",
  remediation: "Type an answer, then press enter.",
  possibleEffects: "none",
};

/** A blocked Run resting at an authored free-text Human Gate, with the message and the
 *  declared output the answer binds. */
export type FreeTextGate = {
  gate: RunGateReference;
  message: string;
  outputName?: string;
  /** Authored quick-choice answers (#213); empty when the gate authored none. */
  suggestions: readonly string[];
};

export interface GateControl {
  /** The free-text gate the Run rests at, or undefined. */
  readonly active: Accessor<FreeTextGate | undefined>;
  readonly text: Accessor<string>;
  /** The highlighted suggestion's index, or -1 for Other (the typed answer). */
  readonly choice: Accessor<number>;
  /** Bound to the native text field's `onInput`. */
  onInput(value: string): void;
  readonly pending: Accessor<boolean>;
  readonly refusal: Accessor<Problem | undefined>;
  /** Handle a key while the gate is up. Returns true if the gate is live — the control
   *  is modal and consumes every key — so the Workbench stops dispatching. */
  handleKey(name: string): boolean;
}

/** The Workbench's free-text Human Gate control. `run`/`answerOffer` decide when the
 *  gate is up; `answerText` publishes the typed answer; `onLeave` leaves the Workbench. */
export function createGateControl(deps: {
  run: Accessor<RunView | undefined>;
  answerOffer: Accessor<AnswerHumanGateOffer | undefined>;
  answerText: (gate: RunGateReference, text: string) => Accessor<AnswerOutcome>;
  onLeave: () => void;
}): GateControl {
  // A blocked Run resting at an authored free-text Human Gate (#108, spec story 17),
  // backed by its live answer-human-gate Offer. Distinct from the derived Review
  // checkpoint (approve-reject) the CheckpointInteraction handles; an authored
  // approve-reject gate keeps M2's headless answer path — no new TUI control here.
  const active = createMemo<FreeTextGate | undefined>(() => {
    const pending = deps.run()?.pendingGate;
    if (pending === undefined || pending.gate.shape !== "free-text")
      return undefined;
    if (deps.answerOffer() === undefined) return undefined;
    return {
      gate: pending.gate,
      message: pending.message,
      ...(pending.outputArtifactName !== undefined
        ? { outputName: pending.outputArtifactName }
        : {}),
      suggestions: pending.suggestions ?? [],
    };
  });

  // Free-text Human Gate control state (#108): the typed answer, the in-flight
  // submission, and a refusal (an empty answer refused locally, or a Port refusal).
  const [text, setText] = createSignal("");
  // Suggestion choice (#213): ↑/↓ cycle the authored suggestions and Other, filling
  // the field with the chosen text, so a suggestion is submitted through the same
  // text answer as a typed Other. Other restores what the human last typed.
  const [choice, setChoice] = createSignal(-1);
  const [typed, setTyped] = createSignal("");
  const onInput = (value: string) => {
    setText(value);
    const suggestions = active()?.suggestions ?? [];
    if (choice() !== -1 && value === suggestions[choice()]) return;
    setChoice(-1);
    setTyped(value);
  };
  const cycle = (step: 1 | -1) => {
    const suggestions = active()?.suggestions ?? [];
    if (suggestions.length === 0) return;
    // Positions 0..n-1 are suggestions and n is Other.
    const slots = suggestions.length + 1;
    const current = choice() === -1 ? suggestions.length : choice();
    const next = (current + step + slots) % slots;
    setChoice(next === suggestions.length ? -1 : next);
    setText(next === suggestions.length ? typed() : suggestions[next]!);
  };
  const [outcome, setOutcome] = createSignal<Accessor<AnswerOutcome>>();
  const [refusal, setRefusal] = createSignal<Problem | undefined>();
  const pending = () => {
    const accessor = outcome();
    return accessor !== undefined && accessor().kind === "pending";
  };

  // Submit the free-text gate answer (#108). An empty answer is refused locally with
  // no dispatch (AC3); the open snapshot follows the Run leaving `blocked`, so the
  // control disappears on its own once the answer applies.
  const dispatch = () => {
    if (pending()) return;
    const current = active();
    if (current === undefined) return;
    if (text().trim().length === 0) {
      setRefusal(EMPTY_GATE_ANSWER);
      return;
    }
    setRefusal(undefined);
    setOutcome(() => deps.answerText(current.gate, text()));
  };
  followSettlement(outcome, () => setOutcome(undefined), setRefusal);
  // A fresh gate (a different producing Attempt) clears the typed buffer and any
  // refusal so a re-block never inherits the previous gate's half-typed answer.
  onIdentityChange(
    () => {
      const current = active();
      return current !== undefined
        ? `${current.gate.stepId}:${current.gate.attemptId}`
        : "";
    },
    () => {
      setText("");
      setTyped("");
      setChoice(-1);
      setRefusal(undefined);
    },
  );

  // A native OpenTUI <input> the view mounts owns text entry, editing, cursor motion
  // and paste (D9). The Port dispatcher runs before the focused field on the same key
  // event (verified routing order, tui/AGENTS.md), so it claims Enter to submit and Esc
  // to leave and lets every other key reach the field, whose value comes from `onInput`.
  // The field is blurred while the answer is in flight, so no stray key types then.
  const handleKey = (name: string): boolean => {
    if (active() === undefined) return false;
    if (name === "return") dispatch();
    else if (name === "escape") deps.onLeave();
    else if (!pending() && name === "down") cycle(1);
    else if (!pending() && name === "up") cycle(-1);
    // Every other key falls through to the focused native <input>.
    return true;
  };

  return {
    active,
    text,
    choice,
    onInput,
    pending,
    refusal,
    handleKey,
  };
}

/** The free-text Human Gate control (#108, spec story 17): the gate message, the
 *  declared output the answer binds, a native OpenTUI text field (D9 — the field draws
 *  its own caret), and a status/hint line carrying a pending state or a refusal (empty
 *  local or Port). It replaces the footer while the Run rests blocked at the gate. The
 *  field is blurred while the answer is in flight, so no stray key types then. */
export function FreeTextGateControl(props: {
  gate: Accessor<FreeTextGate>;
  text: Accessor<string>;
  choice: Accessor<number>;
  onInput: (value: string) => void;
  pending: Accessor<boolean>;
  refusal: Accessor<Problem | undefined>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const status = () => {
    if (props.pending()) return "… submitting your answer";
    const refusal = props.refusal();
    if (refusal !== undefined)
      return `refused: ${refusal.explanation} ${refusal.remediation}`;
    return props.gate().suggestions.length > 0
      ? "↑↓ choose or type · enter submit · esc back · ctrl+c quit"
      : "type your answer · enter submit · esc back · ctrl+c quit";
  };
  // The chosen entry is bracketed, so the choice reads without colour.
  const choices = () => {
    const labels = [...props.gate().suggestions, "Other (type)"];
    const chosen = props.choice() === -1 ? labels.length - 1 : props.choice();
    return labels
      .map((label, index) => (index === chosen ? `[${label}]` : label))
      .join(" · ");
  };
  return (
    <box
      flexDirection="column"
      height={gateHeight(props.gate())}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={theme.warning} attributes={TextAttributes.BOLD} flexShrink={0}>
        {clip(`› Human Gate · ${props.gate().message}`, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(
          `  Answer published as: ${props.gate().outputName ?? "the gate's text output"}`,
          w(),
        )}
      </text>
      <Show when={props.gate().suggestions.length > 0}>
        <text fg={theme.text} flexShrink={0}>
          {clip(`  Choose: ${choices()}`, w())}
        </text>
      </Show>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.text} flexShrink={0}>
          {"  > "}
        </text>
        <input
          value={props.text()}
          onInput={props.onInput}
          focused={!props.pending()}
          width={Math.max(1, w() - 4)}
        />
      </box>
      <text
        fg={props.refusal() !== undefined ? theme.error : theme.textMuted}
        flexShrink={0}
      >
        {clip(`  ${status()}`, w())}
      </text>
    </box>
  );
}
