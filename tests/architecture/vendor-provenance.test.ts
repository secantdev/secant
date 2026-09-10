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
