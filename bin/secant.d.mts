// Types for the shipped Node launcher (bin/secant.mjs), which is authored in plain
// JavaScript because it must run under any user Node before a Secant runtime exists.
// This declaration lets the deterministic launcher unit tests import the launcher's
// pure resolution logic without `tsc` needing to check the .mjs body itself.

export interface LauncherPlatformEntry {
  package: string;
  executable: string;
}
export type LauncherPlatforms = Record<string, LauncherPlatformEntry>;

export interface LauncherTarget {
  key: string;
  package: string;
  executable: string;
}

/** Choose this host's platform package, or throw a before-spawn diagnostic naming
 *  the supported platforms. */
export function selectTarget(
  platforms: LauncherPlatforms,
  platform: string,
  arch: string,
): LauncherTarget;

/** Resolve the absolute path of the installed executable for this host, or throw a
 *  before-spawn diagnostic. `resolvePackageJson` resolves a platform package's
 *  package.json exactly as Node would from the launcher's real location. */
export function resolveExecutable(options: {
  platforms: LauncherPlatforms;
  platform: string;
  arch: string;
  resolvePackageJson: (name: string) => string;
}): string;
