import type {
  BundleOriginView,
  BundleTrustState,
  EngineRange,
} from "../application/projection-port.js";

// Semantic text for the status facts the Bundle catalog carries, worded to match
// the headless client (headless.ts renderEngine/renderTrust) so the TUI shows
// exactly the same facts. Every status reads without colour: the words are the
// signal, colour is only added on top.

export function formatEngine(engine: EngineRange): string {
  return engine.satisfied ? engine.range : `${engine.range} (${engine.note})`;
}

// The origin as ADR 0029 words it, with the marker on the row the running Secant
// ships; a local origin keeps its kind and location.
export function formatOrigin(
  origin: BundleOriginView,
  shippedWithRunningSecant = false,
): string {
  if (origin.kind !== "built-in") return `${origin.kind} ${origin.location}`;
  const marker = shippedWithRunningSecant ? " · in this release" : "";
  return `Built-in, shipped with Secant ${origin.secantVersion}${marker}`;
}

export function formatTrust(trust: BundleTrustState): string {
  switch (trust.state) {
    case "not-yet-trusted":
      return "not yet trusted";
    case "app-release":
      return "trusted (app release)";
    case "trusted":
      return `trusted (granted ${trust.grantedAt})`;
  }
}
