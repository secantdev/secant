import { register } from "node:module";

// Registers the TypeScript test loader via `--import`: it compiles `.tsx` with
// Solid's universal transform and `.ts` by stripping types.
register("./solid-test-loader.mjs", import.meta.url);
