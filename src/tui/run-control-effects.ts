import { createEffect, type Accessor } from "solid-js";
import type { Problem } from "../application/projection-port.js";
import type { AnswerOutcome } from "./run-view.js";

// The two settle-and-identity effects the Workbench's answer, request, and gate write
// controls share (A33). Split out of run-workbench.tsx so the approval-request and
// free-text-gate controls can own them in their private files while the checkpoint
// answer keeps them in the Workbench root. Moved verbatim from run-workbench.tsx.

/** One settle-and-clear follow shared by the write seams (answer, request, gate): a
 *  refusal surfaces and re-enables the control, then the in-flight outcome clears. An
 *  applied answer clears too — the live snapshot drops the offer, so each control
 *  disappears on its own. */
export function followSettlement(
  outcome: Accessor<Accessor<AnswerOutcome> | undefined>,
  clear: () => void,
  setRefusal: (problem: Problem) => void,
): void {
  createEffect(() => {
    const accessor = outcome();
    if (accessor === undefined) return;
    const settled = accessor();
    if (settled.kind === "pending") return;
    if (settled.kind === "refused") setRefusal(settled.problem);
    clear();
  });
}

/** Run `reset` whenever a control's identity changes — a fresh request id or a fresh
 *  gate Attempt — so a re-block never inherits the previous interaction's local state.
 *  (The checkpoint has its own keyed effect; it also moves focus.) */
export function onIdentityChange(
  identity: Accessor<string>,
  reset: () => void,
): void {
  let last = "";
  createEffect(() => {
    const current = identity();
    if (current !== last) {
      last = current;
      reset();
    }
  });
}
