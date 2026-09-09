import { defineConfig } from "tsup";

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
  banner: {
    js: "#!/usr/bin/env node",
  },
});
