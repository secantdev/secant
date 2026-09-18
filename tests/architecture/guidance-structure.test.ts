import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { makeTempDir } from "../helpers/tempDir.js";
import { checkGuidanceStructure, limits } from "./check-guidance-structure.js";

test("the repository's guidance tree respects its declared limits and pointers", () => {
  const issues = checkGuidanceStructure(process.cwd());
  assert.deepEqual(issues, [], JSON.stringify(issues, null, 2));
});

async function audit(files: Record<string, string>) {
  const root = makeTempDir("devflow-guidance-structure-");
  const contents = { "AGENTS.md": "# Agent Instructions\n", ...files };
  for (const [path, content] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, issues: checkGuidanceStructure(root) };
}

const messages = (issues: { message: string }[]) =>
  issues.map((issue) => issue.message);

test("a compliant tree with an indexed Module-local file passes", async () => {
  const { issues } = await audit({
    "AGENTS.md":
      "# Agent Instructions\n\n- Before editing under `src/harness/`, read `src/harness/AGENTS.md`.\n- Read `docs/agents/testing.md`.\n",
    "CLAUDE.md": "@AGENTS.md\n",
    "docs/agents/testing.md": "# Testing\n\nSee [guidance](./guidance.md).\n",
    "docs/agents/guidance.md": "# Guidance\n",
    "src/harness/AGENTS.md": "# Harness\n\n## Owns\n\nQualification.\n",
    "tests/harness/fixtures/codex/resume/recording.jsonl": "{}\n",
    "tests/harness/fixtures/codex/resume/recording.json": JSON.stringify({
      harness: "codex",
      executableVersion: "0.1.0",
      protocolVersion: "codex-probe-2",
      recordedAt: "2026-09-06T00:00:00.000Z",
      redactions: [{ placeholder: "«HOME»", reason: "user home path" }],
      refreshCommand: "bun tests/harness/record-codex.ts resume",
    }),
  });
  assert.deepEqual(issues, []);
});

test("the root index and focused documents have hard line caps", async () => {
  const { issues } = await audit({
    "AGENTS.md": "- line\n".repeat(limits.rootLines + 1),
    "docs/agents/testing.md": "line\n".repeat(limits.focusedLines + 1),
  });
  assert.ok(
    messages(issues).some((m) =>
      m.includes(`Root AGENTS.md exceeds ${limits.rootLines}`),
    ),
  );
  assert.ok(
    messages(issues).some((m) =>
      m.includes(`exceeds ${limits.focusedLines} lines`),
    ),
  );
});

test("CLAUDE.md must be the @AGENTS.md import, never a symlink or other text", async () => {
  const symlinked = await audit({});
  await symlink("AGENTS.md", join(symlinked.root, "CLAUDE.md"));
  assert.ok(
    messages(checkGuidanceStructure(symlinked.root)).some((m) =>
      m.includes("not a symlink"),
    ),
  );
  const { issues } = await audit({ "CLAUDE.md": "# Duplicate\n" });
  assert.ok(messages(issues).some((m) => m.includes("only @AGENTS.md")));
});

test("prose wraps at the column limit while URLs, table rows, and fences are exempt", async () => {
  const long = "a".repeat(limits.proseColumns + 1);
  const { issues } = await audit({
    "docs/agents/testing.md": [
      long,
      `see https://example.com/${long}`,
      `| ${long} |`,
      "```",
      long,
      "```",
      "",
    ].join("\n"),
  });
  assert.equal(
    messages(issues).filter((m) => m.includes("Prose exceeds")).length,
    1,
  );
  assert.equal(issues[0]?.line, 1);
});

test("relative links and backticked guidance paths must resolve", async () => {
  const { issues } = await audit({
    "AGENTS.md": "# Agent Instructions\n\n- Read `docs/agents/missing.md`.\n",
    "docs/agents/testing.md":
      "[gone](./gone.md) [ok](../../AGENTS.md) [anchor](#here) [web](https://x.test/a.md)\n",
    "docs/adr/0001-x.md":
      "See [adr](./0002-missing.md) and `some/opencode/AGENTS.md`.\n",
  });
  assert.deepEqual(messages(issues).sort(), [
    "Broken link ./0002-missing.md",
    "Broken link ./gone.md",
    "Unresolved guidance path docs/agents/missing.md",
  ]);
});

test("Module-local AGENTS.md sits at a declared Module root and is indexed in root AGENTS.md", async () => {
  const { issues } = await audit({
    "src/harness/AGENTS.md": "# Harness\n",
    "src/harness/native/AGENTS.md": "# Native\n",
  });
  assert.deepEqual(messages(issues).sort(), [
    "Module-local AGENTS.md must be listed by path in root AGENTS.md",
    "Module-local AGENTS.md must be listed by path in root AGENTS.md",
    "Module-local AGENTS.md must sit at a declared Module root",
  ]);
  assert.equal(
    issues.find((issue) => issue.message.includes("declared Module root"))
      ?.file,
    "src/harness/native/AGENTS.md",
  );
});

test("recorded Harness fixtures carry a complete recording.json sidecar", async () => {
  const { issues } = await audit({
    "tests/harness/fixtures/codex/bare/events.jsonl": "{}\n",
    "tests/harness/fixtures/claude/partial/recording.json": JSON.stringify({
      harness: "claude",
    }),
  });
  assert.ok(
    messages(issues).some((m) => m === "Recorded fixture lacks recording.json"),
  );
  assert.ok(
    messages(issues).some((m) =>
      m.startsWith("recording.json lacks executableVersion, protocolVersion"),
    ),
  );
});

test("recorded Harness provenance is exact and unsafe fixture bytes are refused", async () => {
  const { issues } = await audit({
    "tests/harness/fixtures/codex/bad/case.json":
      '{"token":"sk-abcdefghijklmnopqrstuvwxyz012345"}\n',
    "tests/harness/fixtures/codex/bad/recording.json": JSON.stringify({
      harness: "codex",
      executableVersion: "",
      protocolVersion: "app-server v1",
      recordedAt: "synthetic",
      redactions: ["paths"],
      refreshCommand: "bun record",
      extra: true,
    }),
  });
  assert.deepEqual(messages(issues).sort(), [
    "Codex protocolVersion must name a codex-probe revision",
    "Synthetic recording refreshCommand must state why it is synthetic",
    "recording still matches credential pattern(s): OpenAI-style API key",
    "recording.json has invalid executableVersion",
    "recording.json has invalid redactions",
    "recording.json has unexpected extra",
  ]);
});
