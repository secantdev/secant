import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ownerOf } from "./module-policy.js";

export interface GuidanceIssue {
  file: string;
  line: number;
  message: string;
}

export const limits = {
  rootLines: 60,
  focusedLines: 120,
  proseColumns: 175,
} as const;

const sidecarKeys = [
  "harness",
  "executableVersion",
  "protocolVersion",
  "recordedAt",
  "redactions",
  "refreshCommand",
] as const;

/** Reads the guidance tree as text; loads and executes nothing. */
export function checkGuidanceStructure(root: string): GuidanceIssue[] {
  const issues: GuidanceIssue[] = [];
  const pathOf = (path: string) => relative(root, path).split(sep).join("/");
  const report = (file: string, line: number, message: string) =>
    issues.push({ file: pathOf(file), line, message });
  const linesOf = (file: string) => readFileSync(file, "utf8").split("\n");

  const rootIndex = join(root, "AGENTS.md");
  if (!existsSync(rootIndex)) {
    report(rootIndex, 1, "Root AGENTS.md is the always-loaded index");
    return issues;
  }
  const rootText = readFileSync(rootIndex, "utf8");
  if (linesOf(rootIndex).length > limits.rootLines)
    report(rootIndex, 1, `Root AGENTS.md exceeds ${limits.rootLines} lines`);

  const claude = join(root, "CLAUDE.md");
  if (existsSync(claude) || isSymlink(claude)) {
    if (isSymlink(claude))
      report(
        claude,
        1,
        "CLAUDE.md must be an @AGENTS.md import, not a symlink",
      );
    else if (readFileSync(claude, "utf8").trim() !== "@AGENTS.md")
      report(claude, 1, "CLAUDE.md must contain only @AGENTS.md");
  }

  const focused = markdownIn(join(root, "docs/agents"));
  const local = existsSync(join(root, "src"))
    ? findNamed(join(root, "src"), "AGENTS.md")
    : [];
  const wrapped = [
    rootIndex,
    ...focused,
    ...local,
    ...optional(join(root, "CONTEXT.md")),
    ...markdownIn(join(root, "docs/glossary")),
  ];
  const linked = [
    ...wrapped,
    ...markdownIn(join(root, "docs/adr")),
    ...markdownIn(join(root, "docs/research")),
  ];
  const pathChecked = new Set([rootIndex, ...focused]);

  for (const file of [...focused, ...local]) {
    if (linesOf(file).length > limits.focusedLines)
      report(file, 1, `Focused guidance exceeds ${limits.focusedLines} lines`);
  }

  for (const file of local) {
    const directory = pathOf(dirname(file)) + "/";
    if (ownerOf(directory)?.root !== directory)
      report(
        file,
        1,
        "Module-local AGENTS.md must sit at a declared Module root",
      );
    if (!rootText.includes(pathOf(file)))
      report(
        file,
        1,
        "Module-local AGENTS.md must be listed by path in root AGENTS.md",
      );
  }

  for (const file of linked) {
    let fenced = false;
    linesOf(file).forEach((text, index) => {
      const line = index + 1;
      if (text.trimStart().startsWith("```")) fenced = !fenced;
      if (fenced) return;
      if (
        wrapped.includes(file) &&
        text.length > limits.proseColumns &&
        !/https?:\/\//.test(text) &&
        !text.startsWith("|")
      )
        report(file, line, `Prose exceeds ${limits.proseColumns} characters`);
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1];
        if (/^(?:[a-z]+:|#)/.test(target)) continue;
        if (!existsSync(resolve(dirname(file), target.split("#")[0])))
          report(file, line, `Broken link ${target}`);
      }
      if (!pathChecked.has(file)) return;
      for (const match of text.matchAll(/`([^`<>\s@]+\.md)`/g)) {
        const target = match[1];
        if (
          !existsSync(resolve(dirname(file), target)) &&
          !existsSync(resolve(root, target))
        )
          report(file, line, `Unresolved guidance path ${target}`);
      }
    });
  }

  const fixtures = join(root, "tests/harness/fixtures");
  if (existsSync(fixtures)) {
    for (const harness of subdirectories(fixtures)) {
      for (const recording of subdirectories(harness)) {
        const sidecar = join(recording, "recording.json");
        if (!existsSync(sidecar)) {
          report(recording, 1, "Recorded fixture lacks recording.json");
          continue;
        }
        const missing = sidecarKeys.filter(
          (key) => !(key in parseObject(sidecar)),
        );
        if (missing.length)
          report(sidecar, 1, `recording.json lacks ${missing.join(", ")}`);
      }
    }
  }

  return issues;
}

function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function optional(path: string) {
  return existsSync(path) ? [path] : [];
}

function markdownIn(directory: string) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(directory, name));
}

function subdirectories(directory: string) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name))
    .sort();
}

function findNamed(directory: string, name: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findNamed(path, name);
      return entry.name === name ? [path] : [];
    });
}

function parseObject(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
