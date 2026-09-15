import semver from "semver";
import type { CatalogEntry } from "../catalog/catalog.js";
import type { Problem } from "./projection-port.js";
import {
  bundleNotInstalled,
  noStableVersion,
  versionNotInstalled,
} from "./problems.js";

// The one installed-Entry selector shared by the Bundle-catalog focus join and the
// Run-launch/Run-projection join (#98 A18): both resolve an id (and an optional
// version) to exactly one Installed Bundle by the same rule — an omitted version is
// the highest stable installed version; a prerelease must be named (#9, #49). Kept
// in one place so the two joins can never drift on how "highest stable" is decided.

/** Select the installed Entry an id (and optional version) names. An omitted
 *  version is the highest stable installed version; a prerelease must be named. */
export function selectInstalledEntry(
  entries: readonly CatalogEntry[],
  id: string,
  version: string | undefined,
): { entry: CatalogEntry } | { problem: Problem } {
  const matching = entries.filter((entry) => entry.id === id);
  if (matching.length === 0) return { problem: bundleNotInstalled(id) };
  if (version !== undefined) {
    const exact = matching.find((entry) => entry.version === version);
    return exact
      ? { entry: exact }
      : { problem: versionNotInstalled(id, version) };
  }
  const stable = matching
    .filter((entry) => semver.prerelease(entry.version) === null)
    .sort((a, b) => semver.rcompare(a.version, b.version));
  return stable.length > 0
    ? { entry: stable[0]! }
    : { problem: noStableVersion(id) };
}
