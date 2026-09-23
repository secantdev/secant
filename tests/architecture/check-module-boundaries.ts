import { isBuiltin } from "node:module";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { externalViolation, ownerOf } from "./module-policy.js";

export interface BoundaryIssue {
  file: string;
  line: number;
  message: string;
}

// Test folders that do not mirror a source domain (S1): the architecture checks,
// shared helpers, shared fixtures, the human release checks, release-script tests,
// and the real-terminal suite. Every other `tests/<prefix>/` folder mirrors
// `src/<prefix>/`.
const NON_MIRRORING_TEST_FOLDERS = new Set([
  "architecture",
  "helpers",
  "fixtures",
  "release",
  "release-checks",
  "terminal",
]);

/** Mechanise the prose rule "tests mirror their source domain" (S1): a test under
 *  `tests/<prefix>/` that imports any owned Module must import at least one whose
 *  root starts with `src/<prefix>/`. A test importing no target source at all (a
 *  pure-helper suite such as `tests/harness/redact.test.ts`, which imports only its
 *  sibling test helper) is skipped; the non-mirroring folders above are skipped wholesale.
 *  This catches a suite filed by ticket rather than by the Interface it crosses. */
export function checkTestDomainMirror(root: string): BoundaryIssue[] {
  const issues: BoundaryIssue[] = [];
  const testsRoot = join(root, "tests");
  if (!existsSync(testsRoot)) return issues;
  const pathOf = (path: string) => relative(root, path).split(sep).join("/");
  const files: string[] = [];
  const discover = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) discover(path);
      else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) files.push(path);
    }
  };
  discover(testsRoot);

  for (const file of files.sort()) {
    const relPath = pathOf(file);
    const segments = relPath.split("/");
    // tests/<prefix>/…; a file directly under tests/ has no domain to mirror.
    if (segments.length < 3) continue;
    const prefix = segments[1]!;
    if (NON_MIRRORING_TEST_FOLDERS.has(prefix)) continue;

    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const importedModules: string[] = [];
    const record = (specifier: string) => {
      if (!specifier.startsWith(".")) return;
      const target = pathOf(resolve(dirname(file), specifier));
      const owner = ownerOf(target);
      if (owner) importedModules.push(owner.root);
    };
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        record(node.moduleSpecifier.text);
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        record(node.argument.literal.text);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        record(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    // Zero-import skip: a suite that touches no owned Module is not mirroring
    // anything and is left alone (the declared exception for such tests).
    if (importedModules.length === 0) continue;
    if (
      !importedModules.some((moduleRoot) =>
        moduleRoot.startsWith(`src/${prefix}/`),
      )
    ) {
      issues.push({
        file: relPath,
        line: 1,
        message: `Test under tests/${prefix}/ must import a Module rooted at src/${prefix}/ (it imports ${[...new Set(importedModules)].join(", ")}); move it to the folder mirroring its domain (S1)`,
      });
    }
  }
  return issues;
}

/** Uses the project's resolver and real source graph; does not load or execute any production Module. */
export function checkModuleBoundaries(root: string): {
  issues: BoundaryIssue[];
  targetFiles: number;
} {
  root = realpathSync(root);
  const issues: BoundaryIssue[] = [];
  const configPath = join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        )
        .join("\n"),
    );
  }
  let targetCount = 0;
  const pathOf = (path: string) => relative(root, path).split(sep).join("/");
  const files: string[] = [];
  function discover(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push({
          file: pathOf(path),
          line: 1,
          message:
            "Source symlinks bypass ownership; use ordinary source files",
        });
      } else if (entry.isDirectory()) discover(path);
      else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) files.push(path);
    }
  }
  discover(join(root, "src"));
  if (existsSync(join(root, "tests"))) discover(join(root, "tests"));
  for (const file of files.sort()) {
    const path = pathOf(file);
    const isTest = path.startsWith("tests/");
    const owner = ownerOf(path);
    if (!owner && !isTest) {
      issues.push({
        file: path,
        line: 1,
        message: "Source has no target owner",
      });
      continue;
    }
    if (owner) targetCount++;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const report = (node: ts.Node, message: string) => {
      issues.push({
        file: path,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        message,
      });
    };
    const clientContract =
      path === "src/application/projection-port.ts" ||
      path === "src/application/bundle-management.ts" ||
      path.startsWith("src/application/contracts/");

    function checkImport(node: ts.Node, specifier: string, reexport = false) {
      const resolved = ts.resolveModuleName(
        specifier,
        file,
        parsed.options,
        ts.sys,
      ).resolvedModule;
      const staticAsset =
        resolved === undefined && specifier.startsWith(".")
          ? resolve(dirname(file), specifier)
          : undefined;
      const resolvedPath =
        resolved?.resolvedFileName ??
        (staticAsset !== undefined && existsSync(staticAsset)
          ? staticAsset
          : undefined);
      const target = resolvedPath && pathOf(realpathSync(resolvedPath));
      if (
        target &&
        !target.startsWith("../") &&
        !target.startsWith("node_modules/") &&
        !target.includes("/node_modules/")
      ) {
        const other = ownerOf(target);
        if (owner && !other) {
          report(
            node,
            "Target code cannot import legacy or unowned implementation: " +
              target,
          );
          return;
        }
        if (
          clientContract &&
          !(
            target === "src/application/projection-port.ts" ||
            target === "src/application/bundle-management.ts" ||
            target.startsWith("src/application/contracts/")
          )
        ) {
          report(
            node,
            "Application client contracts must stay independent of implementation: " +
              target,
          );
          return;
        }
        if (!other || owner?.name === other.name) return;
        const isPublic =
          target === other.root + other.entry ||
          ("contracts" in other &&
            other.contracts.some((entry) => target === other.root + entry));
        if (!isPublic)
          report(
            node,
            "Cross-Module import must use a declared public entrypoint: " +
              target,
          );
        if (other.name === "composition" && !isTest && owner?.name !== "cli") {
          report(
            node,
            "Only the CLI host may invoke the outer composition root",
          );
        }
        if (
          owner &&
          !(owner.imports as readonly string[]).includes(other.name)
        ) {
          report(node, `${owner.name} cannot import ${other.name}`);
        }
        if (owner && reexport)
          report(
            node,
            "Expose this Module's contract; do not re-export another owner's surface",
          );
        if (
          (owner?.name === "tui" || owner?.name === "headless") &&
          target === "src/application/application.ts"
        ) {
          report(
            node,
            "Clients receive Application Interfaces; only composition constructs the application",
          );
        }
        return;
      }
      if (!owner) return;
      if (clientContract)
        report(
          node,
          "Application client contracts must not depend on external packages or native types",
        );
      const forbidden =
        externalViolation(owner.name, specifier) ||
        (resolved?.packageId &&
          externalViolation(owner.name, resolved.packageId.name));
      if (forbidden) report(node, forbidden);
      if (owner.name === "workflow" && isBuiltin(specifier))
        report(
          node,
          "Workflow composition is execution-free and cannot import Node mechanisms",
        );
      // A `bun:` builtin does not resolve to an installed dependency; the
      // allowlist (check-vendor-provenance) governs whether it is permitted at
      // all, but ownership rules above (e.g. SQLite) still apply here.
      if (
        !isBuiltin(specifier) &&
        !specifier.startsWith("bun:") &&
        (!resolved || !resolved.isExternalLibraryImport)
      ) {
        report(
          node,
          "Import cannot be assigned to an installed dependency or owned source: " +
            specifier,
        );
      }
    }

    if (
      owner &&
      (source.referencedFiles.length || source.typeReferenceDirectives.length)
    ) {
      report(
        source,
        "Use explicit module imports instead of triple-slash references",
      );
    }
    function visit(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        checkImport(
          node,
          node.moduleSpecifier.text,
          ts.isExportDeclaration(node),
        );
        if (owner && ts.isExportDeclaration(node) && !node.exportClause)
          report(
            node,
            "Public exports must name their intended surface; wildcard barrels are not allowed",
          );
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        checkImport(node, node.argument.literal.text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        if (owner)
          report(
            node,
            "Target code uses ESM imports, not require-style import assignments",
          );
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteralLike(argument))
            checkImport(node, argument.text);
          else if (owner)
            report(
              node,
              "Computed imports cannot be checked; use an explicit table of literal imports",
            );
        } else if (
          owner &&
          ts.isIdentifier(node.expression) &&
          (node.expression.text === "require" ||
            node.expression.text === "eval")
        ) {
          report(
            node,
            "Target code cannot bypass the declared ESM dependency graph with require or eval",
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { issues, targetFiles: targetCount };
}
