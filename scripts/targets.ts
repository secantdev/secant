// The three gated compile targets (ADR 0030) and the host's target: the one
// authoritative manifest that owns each target's compile triple, OS, CPU, built
// binary filename, release archive name/type, inner executable name, and
// platform npm-package identity, so the build, smoke, terminal, release
// assembly, and consumer-verification consumers never drift on those facts
// (#150). Plain data with no Bun dependency, so every Bun script and test can
// import it. `outfile` is the built binary's basename under dist/.

export type ArchiveType = "zip" | "tar.gz";

export interface CompileTarget {
  /** The `bun build --compile` target triple. */
  readonly triple: Bun.Build.CompileTarget;
  /** The built binary's basename under dist/. */
  readonly outfile: string;
  /** Support-matrix operating system name (docs/support-matrix.md). */
  readonly os: "windows" | "macos" | "linux";
  /** Support-matrix CPU architecture. */
  readonly cpu: "x64" | "arm64";
  /** Release archive basename (spec #137, ADR 0030). */
  readonly archive: string;
  /** Release archive container format. */
  readonly archiveType: ArchiveType;
  /** The executable's name inside the archive as a consumer receives it. */
  readonly executable: string;
  /** The per-platform npm package that carries this binary (thin-launcher channel). */
  readonly package: string;
}

export const TARGETS: Record<string, CompileTarget> = {
  "windows-x64": {
    triple: "bun-windows-x64",
    outfile: "secant-windows-x64.exe",
    os: "windows",
    cpu: "x64",
    archive: "secant-windows-x64.zip",
    archiveType: "zip",
    executable: "secant.exe",
    package: "@secantdev/secant-windows-x64",
  },
  "darwin-arm64": {
    triple: "bun-darwin-arm64",
    outfile: "secant-darwin-arm64",
    os: "macos",
    cpu: "arm64",
    archive: "secant-darwin-arm64.zip",
    archiveType: "zip",
    executable: "secant",
    package: "@secantdev/secant-darwin-arm64",
  },
  "linux-x64": {
    triple: "bun-linux-x64",
    outfile: "secant-linux-x64",
    os: "linux",
    cpu: "x64",
    archive: "secant-linux-x64.tar.gz",
    archiveType: "tar.gz",
    executable: "secant",
    package: "@secantdev/secant-linux-x64",
  },
};

/** The gated target key for this host, or undefined when it is not one of the three. */
export function hostTargetKey(
  platform: string,
  arch: string,
): string | undefined {
  const os = platform === "win32" ? "windows" : platform;
  const key = `${os}-${arch}`;
  return key in TARGETS ? key : undefined;
}
