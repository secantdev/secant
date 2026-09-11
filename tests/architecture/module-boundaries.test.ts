import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { makeTempDir } from "../helpers/tempDir.js";
import { checkModuleBoundaries } from "./check-module-boundaries.js";
import { modules } from "./module-policy.js";

test("production imports and tests respect target Module ownership", () => {
  const result = checkModuleBoundaries(process.cwd());
  assert.deepEqual(result.issues, [], JSON.stringify(result.issues, null, 2));
});

test("the declared ownership graph names existing owners and has no cycles", () => {
  const byName = new Map(
    modules.map((module) => [module.name as string, module]),
  );
  function walk(name: string, trail: string[]) {
    assert.ok(
      !trail.includes(name),
      `Ownership cycle: ${[...trail, name].join(" -> ")}`,
    );
    const module = byName.get(name);
    assert.ok(module, `Unknown owner: ${name}`);
    for (const next of module.imports) walk(next, [...trail, name]);
  }
  for (const module of modules) walk(module.name, []);
});

async function audit(files: Record<string, string>, compilerOptions = {}) {
  const root = makeTempDir("secant-module-boundaries-");
  const contents = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "bundler",
        ...compilerOptions,
      },
      include: ["src"],
    }),
    ...files,
  };
  for (const [path, content] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return checkModuleBoundaries(root);
}

test("a cohesive Module can split privately while clients use its chosen entrypoint", async () => {
  const result = await audit({
    "src/cli/main.ts": 'import { start } from "../composition/main.js";',
    "src/composition/main.ts": 'export { start } from "./wire.js";',
    "src/composition/wire.ts":
      'import { create } from "../application/application.js"; export function start() { return create(); }',
    "src/application/application.ts": "export function create() {}",
    "src/application/projection-port.ts":
      'export type { ProjectionPort } from "./contracts/port.js";',
    "src/application/contracts/port.ts":
      "export interface ProjectionPort { open(): void }",
    "src/tui/tui.ts":
      'import type { ProjectionPort } from "../application/projection-port.js";',
    "src/run/store/store.ts":
      'import { stage } from "./artifacts/artifacts.js";',
    "src/run/store/artifacts/artifacts.ts": "export function stage() {}",
  });
  assert.deepEqual(result.issues, []);
});

for (const [name, statement] of [
  ["value import", 'import { row } from "../run/store/private.js";'],
  ["type-only import", 'import type { Row } from "../run/store/private.js";'],
  ["inline type import", 'import { type Row } from "../run/store/private.js";'],
  ["side-effect import", 'import "../run/store/private.js";'],
  ["named re-export", 'export { row } from "../run/store/private.js";'],
  ["type re-export", 'export type { Row } from "../run/store/private.js";'],
  ["namespace re-export", 'export * as Store from "../run/store/private.js";'],
  ["wildcard re-export", 'export * from "../run/store/private.js";'],
  ["literal dynamic import", 'void import("../run/store/private.js");'],
  [
    "import type expression",
    'type Row = import("../run/store/private.js").Row;',
  ],
]) {
  test(`${name} cannot reach another Module's private implementation`, async () => {
    const result = await audit({
      "src/application/private.ts": statement,
      "src/run/store/private.ts":
        "export const row = 1; export type Row = number;",
    });
    assert.ok(
      result.issues.some((issue) =>
        issue.message.includes("public entrypoint"),
      ),
    );
  });
}

test("aliases resolve to the same private-source restriction", async () => {
  const result = await audit(
    {
      "src/application/private.ts":
        'import type { Row } from "@store/private";',
      "src/run/store/private.ts": "export type Row = number;",
    },
    { paths: { "@store/*": ["./src/run/store/*"] } },
  );
  assert.ok(
    result.issues.some((issue) => issue.message.includes("public entrypoint")),
  );
});

test("clients cannot bypass Application through even a public Run Store entrypoint", async () => {
  const result = await audit({
    "src/headless/headless.ts":
      'import type { Store } from "../run/store/store.js";',
    "src/run/store/store.ts": "export interface Store {}",
  });
  assert.ok(
    result.issues.some(
      (issue) => issue.message === "headless cannot import store",
    ),
  );
});

test("a public contract cannot launder storage types through an internal re-export chain", async () => {
  const result = await audit({
    "src/tui/tui.ts":
      'import type { Store } from "../application/projection-port.js";',
    "src/application/projection-port.ts":
      'export type { Store } from "./contracts/leak.js";',
    "src/application/contracts/leak.ts":
      'export type { Store } from "../../run/store/store.js";',
    "src/run/store/store.ts": "export interface Store {}",
  });
  assert.ok(
    result.issues.some((issue) =>
      issue.message.includes("independent of implementation"),
    ),
  );
});

test("target code cannot import unowned implementation, and unowned source is rejected", async () => {
  const result = await audit({
    "src/run/execution/execution.ts": 'import "../../stray.js";',
    "src/stray.ts": "export const value = true;",
    "src/adapters/stray.ts": "export const other = true;",
  });
  assert.ok(
    result.issues.some((issue) => issue.message.includes("legacy or unowned")),
  );
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "src/adapters/stray.ts" &&
        issue.message.includes("no target owner"),
    ),
  );
});

test("tests cross a target Module's public Interface too", async () => {
  const result = await audit({
    "src/catalog/private.ts": "export const database = 1;",
    "tests/catalog/catalog.test.ts":
      'import { database } from "../../src/catalog/private.js";',
  });
  assert.ok(
    result.issues.some((issue) => issue.message.includes("public entrypoint")),
  );
});

test("Artifact storage is private to Run Store and child composition is private to its root", async () => {
  const result = await audit({
    "src/run/execution/execution.ts":
      'import "../store/artifacts/artifacts.js"; import "../../composition/main.js";',
    "src/run/store/artifacts/artifacts.ts": "export {};",
    "src/composition/main.ts": "export {};",
    "src/composition/child.ts": "export {};",
    "src/cli/main.ts": 'import "../composition/child.js";',
  });
  assert.ok(
    result.issues.some(
      (issue) => issue.message === "execution cannot import artifacts",
    ),
  );
  assert.ok(
    result.issues.some((issue) => issue.message.includes("Only the CLI host")),
  );
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "src/cli/main.ts" &&
        issue.message.includes("public entrypoint"),
    ),
  );
});

test("the bun: spelling of a driver obeys the same ownership as its node: spelling", async () => {
  const result = await audit({
    // `bun:sqlite` is the only admitted SQLite driver (ADR 0030): outside Run
    // Store or Catalog it is rejected, and it is never reported as an
    // unresolvable dependency (runtime neutrality is the allowlist's concern).
    "src/tui/tui.ts": 'import { Database } from "bun:sqlite";',
    "src/run/store/store.ts":
      'import { Database } from "bun:sqlite"; import { dlopen } from "bun:ffi";',
    // `node:sqlite` is no longer admitted anywhere — not even in the Catalog,
    // where it used to be allowed before `bun:sqlite` replaced it.
    "src/catalog/catalog.ts": 'import { DatabaseSync } from "node:sqlite";',
  });
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "src/tui/tui.ts" && issue.message.includes("SQLite"),
    ),
  );
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.file === "src/catalog/catalog.ts" &&
        issue.message.includes("SQLite"),
    ),
  );
  assert.deepEqual(
    result.issues.filter((issue) => issue.file === "src/run/store/store.ts"),
    [],
  );
});

test("native mechanisms stay with their owners and uncheckable loaders fail visibly", async () => {
  const result = await audit({
    "src/workflow/workflow.ts":
      'import "node:fs"; const x = "./x.js"; void import(x);',
    "src/application/internal.ts":
      'import "node:sqlite"; import "@opentui/core"; import "@opencode-ai/sdk"; import "node-pty"; require("x"); import "node:module";',
  });
  for (const expected of [
    "execution-free",
    "Computed imports",
    "SQLite",
    "OpenTUI",
    "OpenCode",
    "require or eval",
    "Custom loaders",
  ]) {
    assert.ok(
      result.issues.some((issue) => issue.message.includes(expected)),
      expected,
    );
  }
});
