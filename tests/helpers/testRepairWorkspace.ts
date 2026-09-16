import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Seed the recorded Test Repair case's exact Git Workspace pre-image. */
export function seedTestRepairWorkspace(workspace: string): {
  readonly failingTest: string;
  readonly baselineCommit: string;
} {
  mkdirSync(workspace, { recursive: true });
  const failingTest = join(workspace, "sum.test.mjs");
  writeFileSync(
    join(workspace, "sum.mjs"),
    "export const sum = (a, b) => a - b;\n",
  );
  writeFileSync(
    failingTest,
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { sum } from "./sum.mjs";',
      'test("adds two numbers", () => assert.equal(sum(2, 3), 5));',
      "",
    ].join("\n"),
  );
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Secant Test"],
    ["config", "user.email", "test@secant.invalid"],
    ["config", "commit.gpgsign", "false"],
    ["add", "sum.mjs", "sum.test.mjs"],
    ["commit", "-q", "-m", "Baseline failing test"],
  ]) {
    execFileSync("git", args, { cwd: workspace });
  }
  const baselineCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
  return { failingTest, baselineCommit };
}
