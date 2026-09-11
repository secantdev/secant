// The three gated compile targets (ADR 0030) and the host's target, shared by
// the build script and the smoke so the binary filenames have one source of
// truth. Plain data with no Bun dependency, so both the Bun build and the Node
// smoke can import it. `outfile` is the basename under dist/.

export const TARGETS = {
  "windows-x64": {
    triple: "bun-windows-x64",
    outfile: "secant-windows-x64.exe",
  },
  "darwin-arm64": {
    triple: "bun-darwin-arm64",
    outfile: "secant-darwin-arm64",
  },
  "linux-x64": { triple: "bun-linux-x64", outfile: "secant-linux-x64" },
};

/** The gated target key for this host, or undefined when it is not one of the three. */
export function hostTargetKey(platform, arch) {
  const os = platform === "win32" ? "windows" : platform;
  const key = `${os}-${arch}`;
  return key in TARGETS ? key : undefined;
}
