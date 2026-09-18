import { TextAttributes } from "@opentui/core";
import { createMemo, createSignal, type Accessor } from "solid-js";
import type {
  AnswerHarnessRequestOffer,
  ApprovalDecisionName,
  Problem,
  RunLiveOverlay,
  RunOutstandingRequest,
} from "../application/projection-port.js";
import { clip } from "./clip.js";
import { followSettlement, onIdentityChange } from "./run-control-effects.js";
import { oneLine } from "./run-timeline-rows.js";
import type { AnswerOutcome } from "./run-view.js";
import { useTheme } from "./vendor/theme-context.js";

// The approval Harness Request control, split out of run-workbench.tsx (A33): its
// state, its self-contained modal key branch, and its view interleave with the rest of
// the Workbench only through the modal-control gate — the same seam the
// reference-inspection overlay was split on (run-inspection.tsx). The controller owns
// everything about answering the outstanding request; the Workbench asks it whether a
// request is live (to gate the Actions rail and the Esc interrupt) and hands it keys
// while it is up. Code moved verbatim from run-workbench.tsx.

type Theme = ReturnType<typeof useTheme>["theme"];

/** Rows the approval Harness Request control occupies while it replaces the footer
 *  (#121, spec story 13/14): a heading, the exact tool, the exact input, the
 *  allow/deny decisions, and a status/hint line that also carries a stale refusal. */
export const REQUEST_HEIGHT = 5;

/** The first outstanding request paired with its live answer Offer. */
export type LiveRequest = {
  request: RunOutstandingRequest;
  offer: AnswerHarnessRequestOffer;
};

export interface RequestControl {
  /** The first outstanding approval Harness Request with its Offer, or undefined. */
  readonly active: Accessor<LiveRequest | undefined>;
  readonly decision: Accessor<ApprovalDecisionName>;
  readonly pending: Accessor<boolean>;
  readonly refusal: Accessor<Problem | undefined>;
  /** Handle a key while a request is outstanding. Returns true if a request is live —
   *  the control is modal and consumes every key — so the Workbench stops dispatching. */
  handleKey(name: string): boolean;
}

/** The Workbench's approval-request control. `live` is the ephemeral Turn overlay;
 *  `answerRequest` dispatches one decision against the request's exact Offer. */
export function createRequestControl(deps: {
  live: Accessor<RunLiveOverlay | undefined>;
  answerRequest: (
    offer: AnswerHarnessRequestOffer,
    decision: ApprovalDecisionName,
  ) => Accessor<AnswerOutcome>;
}): RequestControl {
  // The first outstanding approval Harness Request paired with its live answer
  // Offer (#117): both ride the ephemeral overlay, so the control exists only while
  // the Turn holds the request and vanishes the instant the Turn settles, is
  // interrupted, or is lost — the request is never re-asked (spec story 15). Several
  // may be outstanding; the control answers them one at a time, first outstanding
  // first, and the next surfaces once this one clears.
  const active = createMemo<LiveRequest | undefined>(() => {
    const overlay = deps.live();
    if (overlay === undefined) return undefined;
    const request = overlay.outstanding[0];
    if (request === undefined) return undefined;
    const offer = overlay.offers.find(
      (candidate) => candidate.requestId === request.requestId,
    );
    return offer !== undefined ? { request, offer } : undefined;
  });

  // Approval Harness Request control state (#117): the selected decision, the
  // in-flight answer, and a stale/rejected refusal shown inline while the current
  // offer (bumped to the fresh generation) re-renders.
  const [decision, setDecision] = createSignal<ApprovalDecisionName>("allow");
  const [outcome, setOutcome] = createSignal<Accessor<AnswerOutcome>>();
  const [refusal, setRefusal] = createSignal<Problem | undefined>();
  const pending = () => {
    const accessor = outcome();
    return accessor !== undefined && accessor().kind === "pending";
  };

  // Answer the outstanding approval Harness Request with a decision (#117). A stale
  // generation settles refused — the Application decides, never the client — and the
  // control stays up on the fresh generation with the Problem shown inline (AC2).
  const dispatch = (which: ApprovalDecisionName) => {
    if (pending()) return;
    const current = active();
    if (current === undefined) return;
    setRefusal(undefined);
    setOutcome(() => deps.answerRequest(current.offer, which));
  };
  followSettlement(outcome, () => setOutcome(undefined), setRefusal);
  // A genuinely new request (a fresh requestId) resets the decision to the safer
  // allow and clears any prior refusal; a stale answer keeps the same id, so its
  // inline refusal survives while the bumped-generation offer re-renders (AC2).
  onIdentityChange(
    () => active()?.request.requestId ?? "",
    () => {
      setDecision("allow");
      setRefusal(undefined);
    },
  );

  // Modal while a request is outstanding: ←/→ choose the offered decision, enter
  // confirms it, Esc denies. Other keys are swallowed — the prompt input is disabled
  // only while a request is outstanding. The decisions come straight off the current
  // offer (spec story 13: exactly the decisions Claude Code offered — allow/deny),
  // never a paraphrase.
  const handleKey = (name: string): boolean => {
    const request = active();
    if (request === undefined) return false;
    const decisions = request.offer.decisions;
    switch (name) {
      case "left":
        if (!pending()) setDecision(decisions[0] ?? "allow");
        return true;
      case "right":
        if (!pending()) setDecision(decisions[1] ?? decisions[0] ?? "deny");
        return true;
      case "return":
        dispatch(decision());
        return true;
      case "escape":
        dispatch(
          decisions.includes("deny")
            ? "deny"
            : (decisions[decisions.length - 1] ?? "deny"),
        );
        return true;
      default:
        return true;
    }
  };

  return { active, decision, pending, refusal, handleKey };
}

/** The approval Harness Request control (#117, spec story 13/14): the exact tool
 *  and input Claude Code asked to run, the exact decisions it offered, and a
 *  status/hint line carrying a pending state or a stale-offer refusal. It replaces
 *  the footer while a request is outstanding; every line is plain text so both
 *  decisions read with colour removed. */
export function HarnessRequestControl(props: {
  request: Accessor<RunOutstandingRequest>;
  offer: Accessor<AnswerHarnessRequestOffer>;
  decision: Accessor<ApprovalDecisionName>;
  pending: Accessor<boolean>;
  refusal: Accessor<Problem | undefined>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const decisions = () => props.offer().decisions;
  const marker = (which: ApprovalDecisionName) =>
    props.decision() === which ? "› " : "  ";
  const decisionsLine = () =>
    decisions()
      .map((which) => `${marker(which)}[ ${label(which)} ]`)
      .join("   ");
  const status = () => {
    if (props.pending()) return "… relaying your decision";
    const refusal = props.refusal();
    if (refusal !== undefined)
      return `refused: ${refusal.explanation} ${refusal.remediation}`;
    return "←/→ choose · enter confirm · esc deny · ctrl+c quit";
  };
  return (
    <box
      flexDirection="column"
      height={REQUEST_HEIGHT}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={theme.warning} attributes={TextAttributes.BOLD} flexShrink={0}>
        {clip("› Harness Request · awaiting your approval", w())}
      </text>
      <text fg={theme.text} flexShrink={0}>
        {clip(`  Tool: ${props.request().tool}`, w())}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`  Input: ${oneLine(props.request().input)}`, w())}
      </text>
      <text
        fg={theme.text}
        attributes={props.pending() ? 0 : TextAttributes.BOLD}
        flexShrink={0}
      >
        {clip(
          `  ${decisionsLine()}${props.pending() ? "  (unavailable)" : ""}`,
          w(),
        )}
      </text>
      <text
        fg={props.refusal() !== undefined ? theme.error : theme.textMuted}
        flexShrink={0}
      >
        {clip(`  ${status()}`, w())}
      </text>
    </box>
  );
}

/** The human label for an approval decision (spec story 13). */
function label(decision: ApprovalDecisionName): string {
  return decision === "allow" ? "Allow" : "Deny";
}
