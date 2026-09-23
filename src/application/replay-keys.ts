import { realpathSync } from "node:fs";
import type {
  AnswerHarnessRequestInput,
  AnswerHumanGateInput,
  ContinueRepeatInput,
  EndInteractiveStepInput,
  LaunchRunInput,
  ResumeRunInput,
  SendInteractiveTurnInput,
  SteerTurnInput,
  InterruptTurnInput,
} from "./projection-port.js";

// Closure-free canonicalisers and replay keys live in this private submodule so
// the Application entry retains orchestration rather than pure codecs (#134 A31).

export function canonicalizeWorkspacePath(rawPath: string): string {
  return realpathSync.native(rawPath);
}

export function launchReplayKey(input: LaunchRunInput): string {
  const inputs = Object.entries(input.launchInputs).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify([
    input.bundle.id,
    input.bundle.version ?? null,
    inputs,
    input.trustDigest ?? null,
    input.harness ?? null,
    input.requestedModel ?? null,
  ]);
}

export function resumeReplayKey(input: ResumeRunInput): string {
  return JSON.stringify([
    "resume",
    input.runId,
    input.takeover?.ownerPid ?? null,
  ]);
}

export function answerReplayKey(input: AnswerHumanGateInput): string {
  return JSON.stringify([
    "answer",
    input.runId,
    input.gate.attemptId,
    input.answer ?? null,
    input.text ?? null,
  ]);
}

export function answerHarnessRequestReplayKey(
  input: AnswerHarnessRequestInput,
): string {
  return JSON.stringify([
    "answer-harness-request",
    input.runId,
    input.requestId,
    input.generation,
    input.decision,
    input.by,
  ]);
}

export function interruptTurnReplayKey(input: InterruptTurnInput): string {
  return JSON.stringify(["interrupt-turn", input.runId, input.turnId]);
}

export function steerTurnReplayKey(input: SteerTurnInput): string {
  return JSON.stringify(["steer-turn", input.runId, input.turnId, input.text]);
}

export function sendInteractiveTurnReplayKey(
  input: SendInteractiveTurnInput,
): string {
  return JSON.stringify([
    "send-interactive-turn",
    input.runId,
    input.stepId,
    input.text,
  ]);
}

export function endInteractiveStepReplayKey(
  input: EndInteractiveStepInput,
): string {
  return JSON.stringify(["end-interactive-step", input.runId, input.stepId]);
}

export function continueRepeatReplayKey(input: ContinueRepeatInput): string {
  return JSON.stringify(["continue-repeat", input.runId, input.stepId]);
}

export function cancelReplayKey(runId: string): string {
  return JSON.stringify(["cancel", runId]);
}

export function deleteReplayKey(runId: string): string {
  return JSON.stringify(["delete", runId]);
}
