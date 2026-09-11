import { transformAsync } from "@babel/core";

// Solid's universal transform for the Node test loader. The Bun compile has its
// own `@opentui/solid/bun-plugin`; this Babel path stays until the test runner
// moves to Bun (#64). babel-preset-solid with generate:"universal" targeting
// @opentui/solid is what makes props reactive.
// See the OpenTUI+Solid-under-Node toolchain notes.
const presets = [
  [
    "@babel/preset-typescript",
    { isTSX: true, allExtensions: true, onlyRemoveTypeImports: true },
  ],
  [
    "babel-preset-solid",
    { generate: "universal", moduleName: "@opentui/solid" },
  ],
];

export async function transformSolid(code, filename) {
  const result = await transformAsync(code, {
    filename,
    presets,
    sourceMaps: "inline",
  });
  if (!result?.code)
    throw new Error(`Solid transform produced no output for ${filename}`);
  return result.code;
}
