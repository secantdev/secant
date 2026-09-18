import type {
  LiveObservation,
  LiveRequestView,
  RequestAnswerFn,
  RequestChannel,
} from "../run/execution/execution.js";
import type {
  AnswerHarnessRequestOffer,
  RunLiveOverlay,
  RunOutstandingRequest,
  TurnPhase,
} from "./projection-port.js";
import { UpdateStream } from "./update-stream.js";

export interface LiveOverlayState {
  generation: number;
  phase: TurnPhase;
  readonly outstanding: Map<string, RunOutstandingRequest>;
  answer?: RequestAnswerFn;
  activity?: string;
  preview?: string;
  context?: { readonly usedTokens: number; readonly limitTokens: number };
  usage?: string;
  active: boolean;
}

interface LiveTrackedRun {
  readonly observers: Set<UpdateStream>;
  readonly live: LiveOverlayState;
}

export interface LiveOverlayChannel {
  fresh(): LiveOverlayState;
  push(runId: string, only?: UpdateStream): void;
  requestChannel(runId: string): RequestChannel;
}

/** Own the Application's ephemeral Turn overlay behind one tracking accessor.
 *  Durable Run state stays with the Application; this private submodule owns the
 *  generation, request-answer binding, and coalesced live observations (#134 A31). */
export function createLiveOverlay(
  trackingFor: (runId: string) => LiveTrackedRun | undefined,
): LiveOverlayChannel {
  function fresh(): LiveOverlayState {
    return {
      generation: 0,
      phase: "working",
      outstanding: new Map(),
      active: false,
    };
  }

  function build(runId: string): RunLiveOverlay | undefined {
    const tracking = trackingFor(runId);
    if (tracking === undefined || !tracking.live.active) return undefined;
    const live = tracking.live;
    const outstanding = [...live.outstanding.values()];
    const offers: AnswerHarnessRequestOffer[] = outstanding.map((request) => ({
      action: "answer-harness-request",
      runId,
      requestId: request.requestId,
      generation: live.generation,
      decisions: request.decisions,
      basis: "ephemeral Harness Request",
    }));
    return {
      runId,
      generation: live.generation,
      phase: outstanding.length > 0 ? "awaiting-approval" : live.phase,
      outstanding,
      offers,
      ...(live.activity !== undefined ? { activity: live.activity } : {}),
      ...(live.preview !== undefined ? { preview: live.preview } : {}),
      ...(live.context !== undefined ? { context: live.context } : {}),
      ...(live.usage !== undefined ? { usage: live.usage } : {}),
    };
  }

  function push(runId: string, only?: UpdateStream): void {
    const overlay = build(runId);
    if (overlay === undefined) return;
    const tracking = trackingFor(runId);
    if (tracking === undefined) return;
    const targets = only !== undefined ? [only] : tracking.observers;
    for (const observer of targets) observer.push({ kind: "live", overlay });
  }

  function requestChannel(runId: string): RequestChannel {
    return {
      raised(request: LiveRequestView): void {
        const tracking = trackingFor(runId);
        if (tracking === undefined) return;
        tracking.live.active = true;
        tracking.live.generation += 1;
        tracking.live.outstanding.set(request.requestId, {
          requestId: request.requestId,
          tool: request.tool,
          input: request.input,
          decisions: request.decisions,
        });
        push(runId);
      },
      settled(requestId: string): void {
        const tracking = trackingFor(runId);
        if (tracking === undefined) return;
        if (!tracking.live.outstanding.delete(requestId)) return;
        tracking.live.generation += 1;
        push(runId);
      },
      bindAnswer(answer: RequestAnswerFn | undefined): void {
        const tracking = trackingFor(runId);
        if (tracking === undefined) return;
        tracking.live.answer = answer;
        if (answer !== undefined) {
          tracking.live.active = true;
          tracking.live.phase = "working";
        } else {
          tracking.live.phase = "settling";
          if (tracking.live.outstanding.size > 0) {
            tracking.live.outstanding.clear();
            tracking.live.generation += 1;
          }
          push(runId);
        }
      },
      observe(observation: LiveObservation): void {
        const tracking = trackingFor(runId);
        if (tracking === undefined) return;
        const live = tracking.live;
        live.active = true;
        if (observation.activity !== undefined)
          live.activity = observation.activity;
        if (observation.context !== undefined)
          live.context = observation.context;
        if (observation.usage !== undefined) live.usage = observation.usage;
        if (
          observation.preview !== undefined &&
          observation.activity === undefined &&
          observation.context === undefined &&
          observation.usage === undefined
        ) {
          live.preview = observation.preview;
          for (const observer of tracking.observers) {
            observer.push({ kind: "preview", text: observation.preview });
          }
          return;
        }
        if (observation.preview !== undefined)
          live.preview = observation.preview;
        push(runId);
      },
    };
  }

  return { fresh, push, requestChannel };
}
