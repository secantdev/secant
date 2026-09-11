import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// A structural check that guards the vendored-copy policy (ADR 0018, as extended
// by ADR 0030): target source may call a `Bun.*` runtime API only from the
// allowlisted sites below, and once any vendored file exists the repository must
// carry both provenance records — `UPSTREAM` and `THIRD-PARTY-NOTICES.md`. A file
// is "vendored" when it carries the copy marker below. Pure over a directory
// tree, so it is exercised with synthetic graphs as well as the real repository.

export interface ProvenanceIssue {
  file: string;
  message: string;
}

const VENDOR_MARKER = "Vendored from OpenCode";
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// The runtime-neutrality allowlist (ADR 0030): the few target-source sites that
// must touch a Bun API because no runtime-neutral equivalent exists. The CLI
// entry needs `Bun.main` to detect the compiled-binary entry (`import.meta.main`
// is false in a Bun binary on Windows).
const BUN_API_ALLOWLIST = new Set(["src/cli/main.ts"]);

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
    if (/\bBun\./.test(text) && !BUN_API_ALLOWLIST.has(pathOf(file))) {
      issues.push({
        file: pathOf(file),
        message: "Target source must not call Bun runtime APIs",
      });
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
