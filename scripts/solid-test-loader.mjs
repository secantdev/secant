import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import { transformSolid } from "./solid-transform.mjs";

// A Node module hook that compiles the project's TypeScript for the test runner:
// `.tsx` with Solid's universal transform, `.ts` with type stripping. It owns
// both so nothing else needs to claim `.tsx` (tsx compiles JSX with the
// automatic runtime, which leaves Solid non-reactive). A resolve shim maps a
// local `./x.js` specifier to its sibling `.ts`/`.tsx` (the repo's ESM style).

export async function resolve(specifier, context, next) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    context.parentURL
  ) {
    const base = specifier.slice(0, -3);
    for (const ext of [".tsx", ".ts"]) {
      const candidate = new URL(base + ext, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, format: "module", shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  const isTsx = url.endsWith(".tsx");
  const isTs = url.endsWith(".ts");
  if (!isTsx && !isTs) return next(url, context);
  const raw = await next(url, { ...context, format: "module" });
  const source = raw.source.toString();
  const filename = fileURLToPath(url);
  if (isTsx) {
    return {
      format: "module",
      source: await transformSolid(source, filename),
      shortCircuit: true,
    };
  }
  const result = await transformAsync(source, {
    filename,
    presets: [
      [
        "@babel/preset-typescript",
        { allExtensions: true, onlyRemoveTypeImports: true },
      ],
    ],
    sourceMaps: "inline",
  });
  return { format: "module", source: result.code, shortCircuit: true };
}
