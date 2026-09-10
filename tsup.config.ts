import { defineConfig } from "tsup";
// @ts-expect-error JS helper, no types
import { solidEsbuildPlugin } from "./scripts/solid-transform.mjs";

export default defineConfig({
  entry: { cli: "src/cli/main.ts" },
  format: ["esm"],
  target: "node24",
  clean: true,
  shims: false,
  // Split so the composition root (and the Catalog's node:sqlite it pulls in) is
  // a lazily loaded chunk: the CLI dynamically imports it only after the engine
  // fail-fast passes, so node:sqlite is never reached on an unsupported Node.
  splitting: true,
  // tsup strips the `node:` prefix from builtins by default; keep it, because
  // `node:sqlite` has no bare alias and fails to resolve as `sqlite`.
  removeNodeProtocol: false,
  // The Solid TUI is compiled with Solid's universal transform. `solid-js` and
  // @opentui stay external (bundling `solid-js` would create a second reactive
  // instance at runtime); `browser` resolves `solid-js` to its reactive build,
  // matching @opentui/solid's own `solid-js/dist/solid.js` import.
  esbuildPlugins: [solidEsbuildPlugin()],
  esbuildOptions(options) {
    options.conditions = ["browser", ...(options.conditions ?? [])];
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
