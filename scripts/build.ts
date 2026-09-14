#!/usr/bin/env bun
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import pkg from "../package.json" with { type: "json" };
// @ts-expect-error JS helper, no types
import { TARGETS, hostTargetKey } from "./targets.mjs";

// Compiles the shell to a Bun single-file executable, one per gated target
// (ADR 0030): Windows x64, macOS arm64, Linux x64. `--all` cross-compiles the
// three (the Linux CI leg, after `bun install --os="*" --cpu="*"` has fetched
// every platform's @opentui native package); with no flag it builds only the
// host target, which is all `bun run check`'s per-OS smoke needs. The version is
// embedded as a build-time define — a single-file executable has no on-disk
// package.json to read.

async function compile(triple: string, outfile: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/cli/main.ts"],
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [createSolidTransformPlugin()],
    format: "esm",
    splitting: true,
    compile: { target: triple, outfile: `dist/${outfile}` },
    define: { __SECANT_VERSION__: JSON.stringify(pkg.version) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`bun build --compile failed for ${triple}.`);
  }
  console.log(`Built dist/${outfile} (${triple}).`);
}

const buildAll = process.argv.includes("--all");
const keys = buildAll
  ? Object.keys(TARGETS)
  : [hostTargetKey(process.platform, process.arch)];
for (const key of keys) {
  if (key === undefined) {
    throw new Error(
      `No gated target for ${process.platform}-${process.arch}; the three targets are ${Object.keys(TARGETS).join(", ")}.`,
    );
  }
  await compile(TARGETS[key].triple, TARGETS[key].outfile);
}
