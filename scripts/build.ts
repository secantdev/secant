#!/usr/bin/env bun
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import pkg from "../package.json" with { type: "json" };
import { buildShippedBundles } from "./shipped-bundles.js";
import { TARGETS, hostTargetKey } from "./targets.js";

// Compiles the shell to a Bun single-file executable, one per gated target
// (ADR 0030): Windows x64, macOS arm64, Linux x64. `--all` cross-compiles the
// three (the Linux CI leg, after `bun install --os="*" --cpu="*"` has fetched
// every platform's @opentui native package); with no flag it builds only the
// host target, which is all `bun run check`'s per-OS smoke needs. The version is
// embedded as a build-time define — a single-file executable has no on-disk
// package.json to read. The Shipped Bundles are built once, checked against
// their lock, and embedded in every target's binary as the `builtin/` asset
// directory beside the entry module (ADR 0029 amendment), so all three binaries
// carry the same bytes.

const SHIPPED_BUNDLE_DIR = "dist/builtin";

// The compiler inputs every gated target's binary is built from — entrypoint,
// resolution conditions, the Solid transform, and the version define. The release
// legal-closure inventory (scripts/inventory.ts) walks the exact same input so its
// dependency inventory can never drift from what is actually compiled in; only the
// per-target `compile` field and (for the inventory) `sourcemap` differ.
export function sharedBuildInput(): Bun.BuildConfig {
  return {
    entrypoints: ["./src/cli/main.ts"],
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [createSolidTransformPlugin()],
    format: "esm",
    splitting: true,
    define: { __SECANT_VERSION__: JSON.stringify(pkg.version) },
  };
}

async function compile(
  triple: Bun.Build.CompileTarget,
  outfile: string,
): Promise<void> {
  const result = await Bun.build({
    ...sharedBuildInput(),
    compile: {
      target: triple,
      outfile: `dist/${outfile}`,
      assets: [SHIPPED_BUNDLE_DIR],
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`bun build --compile failed for ${triple}.`);
  }
  console.log(`Built dist/${outfile} (${triple}).`);
}

if (import.meta.main) {
  const buildAll = process.argv.includes("--all");
  const keys = buildAll
    ? Object.keys(TARGETS)
    : [hostTargetKey(process.platform, process.arch)];
  for (const bundle of buildShippedBundles(SHIPPED_BUNDLE_DIR)) {
    console.log(`Built ${bundle.file} (${bundle.digest}).`);
  }
  for (const key of keys) {
    if (key === undefined) {
      throw new Error(
        `No gated target for ${process.platform}-${process.arch}; the three targets are ${Object.keys(TARGETS).join(", ")}.`,
      );
    }
    await compile(TARGETS[key].triple, TARGETS[key].outfile);
  }
}
