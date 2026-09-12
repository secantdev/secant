import type {
  BundleTrustState,
  EngineRange,
} from "../application/projection-port.js";

// Semantic text for the status facts both Bundle screens carry, worded to match
// the headless client (headless.ts renderEngine/renderTrust) so the TUI shows
// exactly the same facts. Every status reads without colour: the words are the
// signal, colour is only added on top.

export function formatEngine(engine: EngineRange): string {
  return engine.satisfied ? engine.range : `${engine.range} (${engine.note})`;
}

export function formatTrust(trust: BundleTrustState): string {
  return trust.state === "not-yet-trusted"
    ? "not yet trusted"
    : "trusted (app release)";
}
