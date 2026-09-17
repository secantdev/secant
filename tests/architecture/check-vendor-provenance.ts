import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { modules } from "./module-policy.js";

// A structural check that guards the vendored-copy policy (ADR 0018, as extended
// by ADR 0030). It is the single runtime-neutrality mechanism: the import-specifier
// ban, the member-access ban, and the textual vendor scan collapse here, so target
// source may touch a Bun runtime API — a `Bun.*` access or a `bun:` import — only at
// an allowlisted site below, and there only the one API that site is keyed to.
// This file also holds the notices-to-dependencies cross-check (D7) and the entry
// declaration-surface check (S2) that guard the same policy from other angles.
//
// The Bun-API scan parses each file with the TypeScript syntax tree (the same
// loader the module-boundary suite uses, D8) rather than a regex: the old regex
// matched only literal `Bun.` or a quoted `bun:`, so the one real access in the
// tree — `(globalThis as { Bun?: … }).Bun?.main` — slipped through, as would
// `globalThis["Bun"]` or an alias. The AST names the exact API each site touches
// and, because comments are not nodes, an allowlist entry with zero real hits is
// caught as a dead grant. Once any vendored file exists the repository must carry
// both provenance records — `UPSTREAM` and `THIRD-PARTY-NOTICES.md`. A file is
// "vendored" when it carries the copy marker below. Pure over a directory tree, so
// it is exercised with synthetic graphs as well as the real repository.

export interface ProvenanceIssue {
  file: string;
  message: string;
}

const VENDOR_MARKER = "Vendored from OpenCode";
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// The runtime-neutrality allowlist (ADR 0030): the few target-source sites that
// must touch a Bun API because no runtime-neutral equivalent exists, each keyed to
// the exact API it is permitted and nothing else. The CLI entry needs `Bun.main`
// to detect the compiled-binary entry (`import.meta.main` is false in a Bun binary
// on Windows). The Catalog and Run Store adapters import `bun:sqlite` behind their
// Interfaces. The Windows console guard imports `bun:ffi` for its `GetConsoleWindow`
// + `IsWindowVisible` conhost probe. A site reaching for a *different* Bun API —
// `Bun.spawn` in the Run Store, say — is rejected until ADR 0030 names it, so the
// grant is per API, not a blanket pass for the file; and an entry whose file no
// longer touches any Bun API is rejected as a dead grant.
//
// Scope: the scan walks `src/` only, so `scripts/` (e.g. `Bun.build` in
// scripts/build.ts) and `tests/` (e.g. `Bun.spawn` in the terminal suite) are
// outside the allowlist by design — runtime neutrality is a shipped-target-code
// rule, and build/test tooling runs under Bun (ADR 0030).
const BUN_API_ALLOWLIST = new Map<string, ReadonlySet<string>>([
  ["src/cli/main.ts", new Set(["Bun.main"])],
  ["src/catalog/catalog.ts", new Set(["bun:sqlite"])],
  ["src/run/store/store.ts", new Set(["bun:sqlite"])],
  ["src/tui/renderer/conhost-notice.ts", new Set(["bun:ffi"])],
]);

/** The Bun API a node touching the `Bun` global reaches for, normalised to a
 *  `Bun.<member>` token. A computed member or a bare reference (an alias like
 *  `const b = Bun`) cannot be named, so it collapses to `Bun`, which no allowlist
 *  entry permits — the safe, fail-closed default. */
function bunMemberToken(reference: ts.Node): string {
  const parent = reference.parent;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === reference
  ) {
    return `Bun.${parent.name.text}`;
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === reference) {
    const argument = parent.argumentExpression;
    return ts.isStringLiteralLike(argument) ? `Bun.${argument.text}` : "Bun";
  }
  return "Bun";
}

/** Every Bun runtime API and `bun:` specifier a source file touches, by parsing
 *  its syntax tree. Catches `Bun.x`, `Bun?.x`, `<expr>.Bun`, `<expr>["Bun"]`, a
 *  bare `Bun` alias, and `bun:` import/require specifiers — not comments or type
 *  positions. */
function bunApiTokens(source: ts.SourceFile): Set<string> {
  const tokens = new Set<string>();
  const specifier = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith("bun:")) {
      tokens.add(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        specifier(node.moduleSpecifier);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifier(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      specifier(node.arguments[0]);
    } else if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "Bun") {
        tokens.add(`Bun.${node.name.text}`);
      } else if (node.name.text === "Bun") {
        tokens.add(bunMemberToken(node));
      }
    } else if (ts.isElementAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "Bun") {
        const argument = node.argumentExpression;
        tokens.add(
          ts.isStringLiteralLike(argument) ? `Bun.${argument.text}` : "Bun",
        );
      } else if (
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "Bun"
      ) {
        tokens.add(bunMemberToken(node));
      }
    } else if (
      ts.isIdentifier(node) &&
      node.text === "Bun" &&
      !isBunPropertyName(node)
    ) {
      tokens.add(bunMemberToken(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return tokens;
}

/** Whether a `Bun` identifier is a *name* rather than a value reference — the
 *  `.Bun` of a property access (handled separately) or a `Bun:` key in a type
 *  literal or object (`{ Bun?: … }`), neither of which reaches the Bun global. */
function isBunPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
  );
}

/** Whether a file spawns with `shell: true` — a shell-out that ADR 0030 / #21
 *  forbid in target source (every spawn resolves the executable directly). */
function hasShellTrue(source: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "shell") ||
        (ts.isStringLiteralLike(node.name) && node.name.text === "shell")) &&
      node.initializer.kind === ts.SyntaxKind.TrueKeyword
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

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

  const allowlistHits = new Set<string>();
  for (const file of files.sort()) {
    const text = readFileSync(file, "utf8");
    const relPath = pathOf(file);
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const tokens = bunApiTokens(source);
    if (tokens.size > 0) {
      const permitted = BUN_API_ALLOWLIST.get(relPath);
      if (permitted === undefined) {
        issues.push({
          file: relPath,
          message:
            "Target source outside the Bun-API allowlist must not call Bun runtime APIs or import bun: modules",
        });
      } else {
        allowlistHits.add(relPath);
        for (const token of tokens) {
          if (!permitted.has(token)) {
            issues.push({
              file: relPath,
              message: `Allowlisted file may touch only ${[...permitted].join(", ")}, not ${token} (ADR 0030 keys each Bun-API site to one API)`,
            });
          }
        }
      }
    }
    if (hasShellTrue(source)) {
      issues.push({
        file: relPath,
        message:
          "Target source must not spawn with `shell: true`; resolve the executable and spawn it directly (ADR 0030, #21)",
      });
    }
    if (text.includes(VENDOR_MARKER)) vendoredFileFound = true;
  }

  // A dead grant: an allowlist entry whose file no longer touches any Bun API. The
  // grant would silently keep a future `Bun.*` addition unchecked, so it must be
  // retired when its last real use goes (D8).
  for (const allowlisted of BUN_API_ALLOWLIST.keys()) {
    const path = join(root, allowlisted);
    if (existsSync(path) && !allowlistHits.has(allowlisted)) {
      issues.push({
        file: allowlisted,
        message:
          "Bun-API allowlist entry has no live Bun access; retire the dead grant (ADR 0030)",
      });
    }
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

// Scope: every *declared* runtime dependency (package.json `dependencies`) must
// carry a THIRD-PARTY-NOTICES.md section that names the package and its exact pin
// (ADR 0018, D7). This answers ADR 0018's promise of an inventory without a
// generator: the notices are hand-written, and this check keeps them from drifting
// from `package.json`. It is scoped to declared runtime dependencies — transitive
// natives (the per-platform `@opentui/core-*` packages, `bun-ffi-structs`) are
// deferred to the M4 licence gate, which walks the shipped artifact's closure.
// devDependencies are not shipped and are out of scope.
export function checkNoticesCoverage(root: string): ProvenanceIssue[] {
  const issues: ProvenanceIssue[] = [];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const notices = readFileSync(join(root, "THIRD-PARTY-NOTICES.md"), "utf8");
  const dependencies: Record<string, string> = pkg.dependencies ?? {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (!notices.includes(`\`${name}\``)) {
      issues.push({
        file: "THIRD-PARTY-NOTICES.md",
        message: `Runtime dependency ${name} has no notices section naming it`,
      });
      continue;
    }
    if (!notices.includes(`\`${version}\``)) {
      issues.push({
        file: "THIRD-PARTY-NOTICES.md",
        message: `Notices for ${name} do not name its exact pin \`${version}\``,
      });
    }
  }
  return issues;
}

// The fenced packages a Module entry's declaration surface must never name (S2).
// A public `.d.ts` that references one means an inferred type crossed the entry
// without an import — the module-boundary check sees no import, so only the emitted
// declaration catches it. The list mirrors the fenced specifiers `module-policy`
// bans (OpenTUI, the MCP SDK, OpenCode packages, PTY transport, the Harness-native
// SDKs).
const BANNED_ENTRY_SPECIFIERS = [
  "@opentui/",
  "@modelcontextprotocol/",
  "@opencode-ai/",
  "node-pty",
  "@anthropic-ai/",
  "@agentclientprotocol/",
  "@google/genai",
  "@openai/",
];

// The one sanctioned exception: the renderer wraps `@opentui/core` and exposes its
// types by design, so `renderer.d.ts` may name that one package and nothing else
// (A29). Every other entry declaration must be free of fenced packages.
const ENTRY_DECLARATION_ALLOWLIST = new Map<string, ReadonlySet<string>>([
  ["src/tui/renderer/renderer.ts", new Set(["@opentui/core"])],
]);

/** The fenced-package references in one entry's declaration text, minus that
 *  entry's allowlisted specifiers. Pure, so a synthetic `.d.ts` exercises it. */
export function scanEntryDeclaration(
  entry: string,
  dtsText: string,
): ProvenanceIssue[] {
  const dtsRel = entry.replace(/\.tsx?$/, ".d.ts");
  const permitted = ENTRY_DECLARATION_ALLOWLIST.get(entry) ?? new Set<string>();
  const issues: ProvenanceIssue[] = [];
  const seen = new Set<string>();
  for (const banned of BANNED_ENTRY_SPECIFIERS) {
    const pattern = new RegExp(
      `["'\`](${banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"'\`]*)["'\`]`,
      "g",
    );
    for (const match of dtsText.matchAll(pattern)) {
      const specifier = match[1]!;
      if (permitted.has(specifier) || seen.has(specifier)) continue;
      seen.add(specifier);
      issues.push({
        file: dtsRel,
        message: `Module entry declaration names the fenced package \`${specifier}\`; a type crossed the entry without an import (S2)`,
      });
    }
  }
  return issues;
}

// Emit each Module entry's `.d.ts` with `tsc --emitDeclarationOnly` and scan the
// declaration surface for a fenced package (S2). This is the one thing the
// import-graph check cannot see: a type inferred across an entry leaves no import
// specifier, only a reference in the emitted declaration. Runs the emit once for
// the whole project (~3 s) and reads each entry's declaration from the temp dir.
export function checkEntryDeclarations(root: string): ProvenanceIssue[] {
  const outDir = mkdtempSync(join(tmpdir(), "secant-entry-dts-"));
  try {
    const emit = spawnSync(
      process.execPath,
      [
        "tsc",
        "-p",
        join(root, "tsconfig.json"),
        "--declaration",
        "--emitDeclarationOnly",
        "--noEmit",
        "false",
        "--outDir",
        outDir,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (emit.status !== 0) {
      return [
        {
          file: "tsconfig.json",
          message: `Declaration emit failed: ${(emit.stderr || emit.stdout || "").trim()}`,
        },
      ];
    }
    const issues: ProvenanceIssue[] = [];
    for (const module of modules) {
      const entry = `${module.root}${module.entry}`;
      const dtsPath = join(outDir, entry.replace(/\.tsx?$/, ".d.ts"));
      if (!existsSync(dtsPath)) continue;
      issues.push(
        ...scanEntryDeclaration(entry, readFileSync(dtsPath, "utf8")),
      );
    }
    return issues;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
