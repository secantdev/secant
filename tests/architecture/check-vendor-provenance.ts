import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// A structural check that guards the vendored-copy policy (ADR 0018, as extended
// by ADR 0030). It is the single runtime-neutrality mechanism: the import-specifier
// ban, the member-access ban, and the textual vendor scan collapse here, so target
// source may touch a Bun runtime API — a `Bun.*` call or a `bun:` import — only at an
// allowlisted site below, and there only the one specifier that site is keyed to.
// Once any vendored file exists the repository must
// carry both provenance records — `UPSTREAM` and `THIRD-PARTY-NOTICES.md`. A file
// is "vendored" when it carries the copy marker below. Pure over a directory
// tree, so it is exercised with synthetic graphs as well as the real repository.

export interface ProvenanceIssue {
  file: string;
  message: string;
}

const VENDOR_MARKER = "Vendored from OpenCode";
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// A `Bun.*` runtime call or a `bun:` module import in any of the three quote
// forms (a `bun:` specifier can be a template literal, which the module-boundary
// bypass treats as a string too). Textual, like the vendor marker below: enough
// to catch the sites the allowlist governs, and any hit is resolved by the
// allowlist anyway.
const BUN_API_USE = /\bBun\.|["'`]bun:/;

// The runtime-neutrality allowlist (ADR 0030): the few target-source sites that
// must touch a Bun API because no runtime-neutral equivalent exists, each keyed to
// the exact specifier it is permitted and nothing else. The CLI entry needs
// `Bun.main` to detect the compiled-binary entry (`import.meta.main` is false in a
// Bun binary on Windows). The Catalog and Run Store adapters import `bun:sqlite`
// behind their Interfaces. The Windows console guard imports `bun:ffi` for its
// `GetConsoleWindow` + `IsWindowVisible` conhost probe. A site reaching for a
// *different* Bun API — `Bun.spawn` in the Run Store, say — is rejected until
// ADR 0030 names it, so the grant is per API, not a blanket pass for the file.
//
// Scope: the scan below walks `src/` only, so `scripts/` (e.g. `Bun.build` in
// scripts/build.ts) and `tests/` (e.g. `Bun.spawn` in the terminal suite) are
// outside the allowlist by design — runtime neutrality is a shipped-target-code
// rule, and build/test tooling runs under Bun (ADR 0030).
const BUN_API_ALLOWLIST = new Map<string, ReadonlySet<string>>([
  ["src/cli/main.ts", new Set(["Bun.main"])],
  ["src/catalog/catalog.ts", new Set(["bun:sqlite"])],
  ["src/run/store/store.ts", new Set(["bun:sqlite"])],
  ["src/tui/renderer/conhost-notice.ts", new Set(["bun:ffi"])],
]);

// Every `Bun.<member>` call and `bun:<module>` specifier, captured so a hit can be
// checked against the file's permitted API rather than merely against the file.
const BUN_API_TOKEN = /\bBun\.\w+|bun:[\w-]+/g;

export function checkVendorProvenance(root: string): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = [];
  const sourceRoot = join(root, "src");
  const pathOf = (path: string) => relative(root, path).split(sep).join("/");

  let vendoredFileFound = false;
  const files: string[] = [];
  function discover(directory: string) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) discover(path);
      else if (SOURCE_EXTENSION.test(entry.name)) files.push(path);
    }
  }
  discover(sourceRoot);

  for (const file of files.sort()) {
    const text = readFileSync(file, "utf8");
    const relPath = pathOf(file);
    if (BUN_API_USE.test(text)) {
      const permitted = BUN_API_ALLOWLIST.get(relPath);
      if (permitted === undefined) {
        issues.push({
          file: relPath,
          message:
            "Target source outside the Bun-API allowlist must not call Bun runtime APIs or import bun: modules",
        });
      } else {
        for (const token of new Set(text.match(BUN_API_TOKEN) ?? [])) {
          if (!permitted.has(token)) {
            issues.push({
              file: relPath,
              message: `Allowlisted file may touch only ${[...permitted].join(", ")}, not ${token} (ADR 0030 keys each Bun-API site to one specifier)`,
            });
          }
        }
      }
    }
    if (text.includes(VENDOR_MARKER)) vendoredFileFound = true;
  }

  if (vendoredFileFound) {
    for (const record of ["UPSTREAM", "THIRD-PARTY-NOTICES.md"]) {
      const recordPath = join(root, record);
      if (!existsSync(recordPath) || !statSync(recordPath).isFile()) {
        issues.push({
          file: record,
          message: `Vendored source requires a ${record} provenance record at the repository root`,
        });
      }
    }
  }

  return issues;
}
