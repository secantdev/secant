import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

const root = process.cwd();
const testsRoot = join(root, "tests");
const ledgerPath = join(root, "docs", "subprocess-test-migration-ledger.md");

const PROCESS_FREE_MARKER_EXCEPTIONS = new Set([
  "tests/architecture/evidence-ledger.test.ts",
  // Production composition is present, but the fake Harness scenario reaches no
  // Command, Git probe, or recorded Harness child.
  "tests/tui/live-run-workbench.test.tsx",
]);

const SUBPROCESS_SOURCE_PATTERNS = [
  /from\s+["'](?:node:)?child_process["']/,
  /(?<!\.)\bspawnCommand\(/,
  /(?<!\.)\bspawnOwnedProcess\(/,
  /\binstall(?:Synthetic)?CodexReplayer\(/,
  /\binstallReplayer\(/,
  /\bwrite(?:Command|Repeat|Materialization)Bundle\(/,
  /\bopen(?:RunGroup|ArtifactRepo|HeadlessHarness)\(/,
  /\bwireApplication\(/,
  /\bexecuteRouting\(/,
  /\bcheckEntryDeclarations\(/,
];
const EVIDENCE_LAYERS = new Set([
  "process-free semantic suite",
  "standalone runtime conformance",
  "compiled-binary acceptance",
]);
const LEDGER_STATUSES = new Set(["open", "done"]);

interface LedgerRow {
  readonly path: string;
  readonly assertion: string;
  readonly layer: string;
  readonly replacement: string;
  readonly status: string;
}

function relativePath(path: string): string {
  return relative(root, path).split(sep).join("/");
}

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && /\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function discoversSubprocess(path: string, source: string): boolean {
  if (PROCESS_FREE_MARKER_EXCEPTIONS.has(path)) return false;
  return SUBPROCESS_SOURCE_PATTERNS.some((pattern) => pattern.test(source));
}

function ledgerRows(markdown: string): LedgerRow[] {
  return markdown.split("\n").flatMap((line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 5) return [];
    const path = /^`([^`]+\.test\.tsx?)`$/.exec(cells[0]!)?.[1];
    if (path === undefined) return [];
    return [
      {
        path,
        assertion: cells[1]!,
        layer: cells[2]!,
        replacement: cells[3]!,
        status: cells[4]!,
      },
    ];
  });
}

function missingLedgerFiles(
  spawning: readonly string[],
  recorded: ReadonlySet<string>,
): string[] {
  return spawning.filter((path) => !recorded.has(path));
}

test("[evidence-ledger] discovery finds direct and indirect children without matching process-free tests", () => {
  const spawningSources = [
    'import { spawn } from "node:child_process";',
    "spawnCommand(options);",
    "spawnOwnedProcess(options);",
    'installCodexReplayer("completion");',
    "installSyntheticCodexReplayer();",
    'installReplayer("1.0.0", fixture);',
    "writeCommandBundle();",
    "writeRepeatBundle(options);",
    "writeMaterializationBundle(options);",
    "openRunGroup(home, workspace);",
    "openArtifactRepo(runDir);",
    "openHeadlessHarness(t);",
    "wireApplication(options);",
    "executeRouting(routing, options);",
    "checkEntryDeclarations(root);",
  ];
  for (const source of spawningSources) {
    assert.equal(
      discoversSubprocess("tests/example/spawning.test.ts", source),
      true,
      source,
    );
  }
  assert.equal(
    discoversSubprocess("tests/example/values.test.ts", "makeTempDir('x');"),
    false,
  );
  assert.equal(
    discoversSubprocess(
      "tests/tui/live-run-workbench.test.tsx",
      "wireApplication({ harnessAdapter: createFake() });",
    ),
    false,
  );
  assert.deepEqual(
    missingLedgerFiles(["tests/example/spawning.test.ts"], new Set<string>()),
    ["tests/example/spawning.test.ts"],
  );
});

test("[evidence-ledger] every subprocess-backed test file has a migration row", () => {
  assert.equal(
    existsSync(ledgerPath),
    true,
    `${relativePath(ledgerPath)} is missing`,
  );
  const rows = ledgerRows(readFileSync(ledgerPath, "utf8"));
  const recorded = new Set(rows.map((row) => row.path));
  const spawning = testFiles(testsRoot)
    .map(relativePath)
    .filter((path) =>
      discoversSubprocess(path, readFileSync(join(root, path), "utf8")),
    )
    .sort();
  const missing = missingLedgerFiles(spawning, recorded);

  assert.deepEqual(
    missing,
    [],
    `Subprocess-backed test files need ledger rows:\n${missing.join("\n")}`,
  );
  for (const row of rows) {
    assert.notEqual(row.assertion, "", `${row.path} has no assertion`);
    assert.equal(
      EVIDENCE_LAYERS.has(row.layer),
      true,
      `${row.path} has unknown evidence layer ${row.layer}`,
    );
    assert.notEqual(row.replacement, "", `${row.path} has no replacement`);
    assert.equal(
      LEDGER_STATUSES.has(row.status),
      true,
      `${row.path} has unknown status ${row.status}`,
    );
    // The migration is complete (#185): every row's replacement is landed, so the
    // ledger is closed. A new `open` row would mean a subprocess test slipped back
    // into an evidence layer without its replacement — fail until it is migrated.
    assert.notEqual(
      row.status,
      "open",
      `${row.path} has an open ledger row; the subprocess-test migration is closed (#185)`,
    );
  }
});
