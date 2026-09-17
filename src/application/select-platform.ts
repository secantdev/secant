import type { Platform } from "../workflow/workflow.js";

// The one platform selector shared by the Preflight join and the Bundle-catalog
// focus join (D13): both pick the invocation platform by the same rule — the host
// when the Bundle declares it, else the first declared platform. Kept in one place
// so the two joins can never drift; the two copies this replaced were byte-identical
// but declared their parameters in the opposite order, so a transposed call
// compiled and returned the wrong platform.

/** The platform whose invocation will run: the host when the Bundle supports it,
 *  else the first declared platform (mirrors `bundleTrustRequired`). */
export function selectPlatform(
  platforms: readonly Platform[],
  host: Platform | undefined,
): Platform {
  if (host !== undefined && platforms.includes(host)) return host;
  return platforms[0] ?? "linux";
}
