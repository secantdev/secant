import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  checkEntryDeclarations,
  checkNoticesCoverage,
  checkVendorProvenance,
  scanEntryDeclaration,
} from "./check-vendor-provenance.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Builds a synthetic repo tree under a shared-helper temp dir (auto-cleaned). */
function synthetic(build: (root: string) => void): string {
  const root = makeTempDir("secant-provenance-");
  mkdirSync(join(root, "src"), { recursive: true });
  build(root);
  return root;
}

test("the real repository satisfies the vendor-provenance policy", () => {
  assert.deepEqual(checkVendorProvenance(repoRoot), []);
});

test("every declared runtime dependency has a notices section naming its pin", () => {
  assert.deepEqual(checkNoticesCoverage(repoRoot), []);
});

test("no Module entry declaration names a fenced package (S2)", () => {
  assert.deepEqual(checkEntryDeclarations(repoRoot), []);
});

test("a fenced package in a non-renderer entry declaration is flagged (S2)", () => {
  // A type inferred across the entry leaves this reference in the emitted .d.ts;
  // the import-graph check never sees it because there is no import.
  const issues = scanEntryDeclaration(
    "src/application/application.ts",
    'export declare function make(): import("@opentui/core").Renderable;\n',
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /@opentui\/core/);
});

test("the renderer entry may name @opentui/core but not another fenced package (S2)", () => {
  assert.deepEqual(
    scanEntryDeclaration(
      "src/tui/renderer/renderer.ts",
      'export declare const r: import("@opentui/core").CliRenderer;\n',
    ),
    [],
  );
  const strayed = scanEntryDeclaration(
    "src/tui/renderer/renderer.ts",
    'export declare const c: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;\n',
  );
  assert.equal(strayed.length, 1);
  assert.match(strayed[0]!.message, /@modelcontextprotocol/);
});

test("a runtime dependency missing from the notices is rejected", () => {
  const root = makeTempDir("secant-notices-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { present: "1.0.0", "missing-dep": "2.3.4" },
    }),
  );
  writeFileSync(
    join(root, "THIRD-PARTY-NOTICES.md"),
    "## present\n\n`present` pinned at `1.0.0`.\n",
  );
  const issues = checkNoticesCoverage(root);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /missing-dep/);
});

test("a notices section that names the wrong pin is rejected", () => {
  const root = makeTempDir("secant-notices-pin-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { drifted: "9.9.9" } }),
  );
  writeFileSync(
    join(root, "THIRD-PARTY-NOTICES.md"),
    "## drifted\n\n`drifted` pinned at `1.0.0`.\n",
  );
  const issues = checkNoticesCoverage(root);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /exact pin `9\.9\.9`/);
});

test("a synthetic Bun.* call in target source is rejected", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "leak.ts"),
      "export const w = Bun.stringWidth('x');\n",
    );
    writeFileSync(join(r, "UPSTREAM"), "x\n");
    writeFileSync(join(r, "THIRD-PARTY-NOTICES.md"), "x\n");
  });
  const issues = checkVendorProvenance(root);
  assert.ok(
    issues.some((issue) => /Bun runtime APIs/.test(issue.message)),
    "expected a Bun.* violation",
  );
});

test("a synthetic bun: import in target source is rejected", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "adapter.ts"),
      'import { Database } from "bun:sqlite";\nexport const db = Database;\n',
    );
  });
  assert.ok(
    checkVendorProvenance(root).some((issue) =>
      /Bun-API allowlist/.test(issue.message),
    ),
    "expected a bun: import violation",
  );
});

test("a bun: specifier written as a template literal does not evade the check", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "sneaky.ts"),
      "export const db = await import(`bun:sqlite`);\n",
    );
  });
  assert.ok(
    checkVendorProvenance(root).some((issue) =>
      /Bun-API allowlist/.test(issue.message),
    ),
    "expected the backtick-quoted bun: import to be flagged",
  );
});

test("an allowlisted target file may touch its permitted Bun API", () => {
  const root = synthetic((r) => {
    mkdirSync(join(r, "src", "cli"), { recursive: true });
    // src/cli/main.ts is keyed to `Bun.main` specifically; using exactly that
    // permitted API passes.
    writeFileSync(
      join(r, "src", "cli", "main.ts"),
      "export const isEntry = Bun.main === import.meta.url;\n",
    );
  });
  assert.deepEqual(checkVendorProvenance(root), []);
});

test("an allowlisted file touching a Bun API other than its permitted one is rejected", () => {
  const root = synthetic((r) => {
    mkdirSync(join(r, "src", "run", "store"), { recursive: true });
    // store.ts is keyed to `bun:sqlite` only; the extra `Bun.spawn` is a
    // different Bun API and must be flagged even though the file is allowlisted.
    writeFileSync(
      join(r, "src", "run", "store", "store.ts"),
      'import { Database } from "bun:sqlite";\nexport const child = Bun.spawn(["true"]);\nexport const d = Database;\n',
    );
  });
  const issues = checkVendorProvenance(root);
  // Exactly the non-permitted API is flagged; the permitted `bun:sqlite` import
  // raises nothing on its own.
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /not Bun\.spawn/);
});

test("the `globalThis.Bun?.main` form the old regex missed is flagged (D8)", () => {
  const root = synthetic((r) => {
    // The exact bypass the regex let through: a member access whose *name* is
    // `Bun`, reached through `globalThis`. At HEAD this passed unchecked.
    writeFileSync(
      join(r, "src", "sneaky.ts"),
      "export const m = (globalThis as { Bun?: { main?: string } }).Bun?.main;\n",
    );
  });
  assert.ok(
    checkVendorProvenance(root).some((issue) =>
      /Bun runtime APIs/.test(issue.message),
    ),
    "expected globalThis.Bun?.main to be flagged",
  );
});

test('`globalThis["Bun"]` and a bare `Bun` alias are flagged (D8)', () => {
  const bracket = synthetic((r) => {
    writeFileSync(
      join(r, "src", "bracket.ts"),
      'export const s = (globalThis as Record<string, { spawn(x: string[]): unknown }>)["Bun"].spawn(["true"]);\n',
    );
  });
  assert.ok(
    checkVendorProvenance(bracket).some((issue) =>
      /Bun runtime APIs/.test(issue.message),
    ),
  );
  const alias = synthetic((r) => {
    writeFileSync(
      join(r, "src", "alias.ts"),
      "declare const Bun: { spawn(x: string[]): unknown };\nconst b = Bun;\nexport const s = b.spawn([]);\n",
    );
  });
  assert.ok(
    checkVendorProvenance(alias).some((issue) =>
      /Bun runtime APIs/.test(issue.message),
    ),
    "aliasing the Bun global must not evade the check",
  );
});

test("a `shell: true` spawn in target source is rejected (D8)", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "spawner.ts"),
      'import { spawnSync } from "node:child_process";\nexport const r = spawnSync("ls", { shell: true });\n',
    );
  });
  assert.ok(
    checkVendorProvenance(root).some((issue) =>
      /shell: true/.test(issue.message),
    ),
    "expected a shell: true spawn to be flagged",
  );
});

test("an allowlist entry with no live Bun access is a dead grant (D8)", () => {
  const root = synthetic((r) => {
    mkdirSync(join(r, "src", "cli"), { recursive: true });
    // src/cli/main.ts is allowlisted for `Bun.main`, but this copy touches no Bun
    // API, so the grant is dead and must be retired.
    writeFileSync(
      join(r, "src", "cli", "main.ts"),
      "export const isEntry = import.meta.url;\n",
    );
  });
  assert.ok(
    checkVendorProvenance(root).some((issue) =>
      /dead grant/.test(issue.message),
    ),
    "expected the unused allowlist entry to be reported",
  );
});

test("the allowlisted `globalThis.Bun?.main` entry form is accepted (D8)", () => {
  const root = synthetic((r) => {
    mkdirSync(join(r, "src", "cli"), { recursive: true });
    // The real main.ts shape resolves to the `Bun.main` token it is keyed to.
    writeFileSync(
      join(r, "src", "cli", "main.ts"),
      "export const m = (globalThis as { Bun?: { main?: string } }).Bun?.main;\n",
    );
  });
  assert.deepEqual(checkVendorProvenance(root), []);
});

test("a vendored file without the provenance records is rejected", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "copied.ts"),
      "// Vendored from OpenCode at commit deadbeef.\nexport const x = 1;\n",
    );
  });
  const missing = checkVendorProvenance(root)
    .map((issue) => issue.file)
    .sort();
  assert.deepEqual(missing, ["THIRD-PARTY-NOTICES.md", "UPSTREAM"]);
});

test("a vendored file with both records present is accepted", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "copied.ts"),
      "// Vendored from OpenCode at commit deadbeef.\nexport const x = 1;\n",
    );
    writeFileSync(join(r, "UPSTREAM"), "provenance\n");
    writeFileSync(join(r, "THIRD-PARTY-NOTICES.md"), "notices\n");
  });
  assert.deepEqual(checkVendorProvenance(root), []);
});
