import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/main.ts" },
  format: ["esm"],
  target: "node24",
  clean: true,
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
