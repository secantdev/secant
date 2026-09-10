import { transformAsync } from "@babel/core";

// Solid's universal transform, shared by the tsup build and the test loader.
// esbuild/tsx alone leave Solid JSX non-reactive; babel-preset-solid with
// generate:"universal" targeting @opentui/solid is what makes props reactive.
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

/** esbuild plugin that runs the Solid transform on every `.tsx` module. */
export function solidEsbuildPlugin() {
  return {
    name: "solid",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async (args) => {
        const { readFile } = await import("node:fs/promises");
        const source = await readFile(args.path, "utf8");
        return {
          contents: await transformSolid(source, args.path),
          loader: "js",
        };
      });
    },
  };
}
