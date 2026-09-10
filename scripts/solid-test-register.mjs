import { register } from "node:module";

// Registers the Solid `.tsx` test loader. Passed via `--import` alongside tsx,
// which keeps handling `.ts`.
register("./solid-test-loader.mjs", import.meta.url);
