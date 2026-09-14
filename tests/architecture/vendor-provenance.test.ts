import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/tempDir.js";
import { checkVendorProvenance } from "./check-vendor-provenance.js";

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
