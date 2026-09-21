import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ProducedArtifact } from "../../../../src/workflow/workflow.js";
import {
  openArtifactRepo as openArtifactRepoWithProcess,
  type ArtifactRepo,
  type StageOutput,
} from "../../../../src/run/store/artifacts/artifacts.js";
import { makeTempDir } from "../../../helpers/tempDir.js";
import {
  createFakeGitProcess,
  createUnavailableGitProcess,
} from "../fake-git-process.js";
import { createFakeProcess } from "../../../process/fake-adapter.js";

const AT = new Date("2026-09-13T12:00:00.000Z");
const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

function output(name: string, text: string): StageOutput {
  return { name, type: "text", content: enc(text) };
}
const required = (...names: string[]): ProducedArtifact[] =>
  names.map((name) => ({ name, type: "text" }));

function openArtifactRepo(runDir: string): ArtifactRepo {
  return openArtifactRepoWithProcess(runDir, createFakeGitProcess());
}

test("staging a commit yields a version id whose blobs read back", () => {
  const repo = openArtifactRepo(makeTempDir("secant-artifacts-"));
  const result = repo.stageCommit(
    "a1",
    required("verdict", "text"),
    [output("verdict", "pass"), output("text", "all good")],
    AT,
  );
  assert.ok(result.ok);
  assert.match(result.versionId, /^[0-9a-f]{40}$/);
  assert.equal(dec(repo.read(result.versionId, "verdict")), "pass");
  assert.equal(dec(repo.read(result.versionId, "text")), "all good");
});

test("a missing required output is refused before anything is committed", () => {
  const runDir = makeTempDir("secant-artifacts-");
  const repo = openArtifactRepo(runDir);
  const result = repo.stageCommit(
    "a1",
    required("verdict", "text"),
    [output("text", "only text")],
    AT,
  );
  assert.ok(!result.ok);
  assert.deepEqual(result.problem, { kind: "missing-output", name: "verdict" });
  // Nothing was committed: the repo was never even initialised.
  assert.ok(!existsSync(join(runDir, "artifacts.git")));
});

test("a required output present with the wrong type is refused", () => {
  const repo = openArtifactRepo(makeTempDir("secant-artifacts-"));
  const result = repo.stageCommit(
    "a1",
    [{ name: "verdict", type: "verdict" }],
    [{ name: "verdict", type: "text", content: enc("pass") }],
    AT,
  );
  assert.ok(!result.ok);
  assert.deepEqual(result.problem, { kind: "missing-output", name: "verdict" });
});

test("every version stays readable by its own id", () => {
  const repo = openArtifactRepo(makeTempDir("secant-artifacts-"));
  const first = repo.stageCommit(
    "a1",
    required("text"),
    [output("text", "old")],
    AT,
  );
  const second = repo.stageCommit(
    "a2",
    required("text"),
    [output("text", "new")],
    AT,
  );
  assert.ok(first.ok && second.ok);
  assert.notEqual(first.versionId, second.versionId);
  assert.equal(dec(repo.read(first.versionId, "text")), "old");
  assert.equal(dec(repo.read(second.versionId, "text")), "new");
});

test("distinct Attempts with identical content get distinct version ids", () => {
  const repo = openArtifactRepo(makeTempDir("secant-artifacts-"));
  const one = repo.stageCommit(
    "a1",
    required("verdict"),
    [output("verdict", "pass")],
    AT,
  );
  const two = repo.stageCommit(
    "a2",
    required("verdict"),
    [output("verdict", "pass")],
    AT,
  );
  assert.ok(one.ok && two.ok);
  assert.notEqual(one.versionId, two.versionId);
  // Retrying the same Attempt reproduces its version id.
  const retry = repo.stageCommit(
    "a1",
    required("verdict"),
    [output("verdict", "pass")],
    AT,
  );
  assert.ok(retry.ok);
  assert.equal(retry.versionId, one.versionId);
});

test("a duplicate output name is a hard error, not undefined git behaviour", () => {
  const repo = openArtifactRepo(makeTempDir("secant-artifacts-"));
  assert.throws(
    () =>
      repo.stageCommit(
        "a1",
        required("text"),
        [output("text", "a"), output("text", "b")],
        AT,
      ),
    /duplicate output name/,
  );
});

test("reading an absent path or version yields undefined, not a throw", () => {
  const repo = openArtifactRepo(makeTempDir("secant-artifacts-"));
  const staged = repo.stageCommit(
    "a1",
    required("text"),
    [output("text", "hi")],
    AT,
  );
  assert.ok(staged.ok);
  assert.equal(repo.read(staged.versionId, "missing"), undefined);
  assert.equal(repo.read("0".repeat(40), "text"), undefined);
});

test("a missing git executable surfaces as a precise Problem", () => {
  const runDir = makeTempDir("secant-artifacts-");
  const repo = openArtifactRepoWithProcess(
    runDir,
    createUnavailableGitProcess(),
  );
  const result = repo.stageCommit("a1", [], [output("text", "hi")], AT);
  assert.ok(!result.ok);
  assert.equal(result.problem.kind, "git-unavailable");
  if (result.problem.kind === "git-unavailable") {
    assert.ok(result.problem.cause instanceof Error);
    assert.equal(
      "code" in result.problem.cause ? result.problem.cause.code : undefined,
      "ENOENT",
    );
  }
});

test("a non-ENOENT Git spawn failure is typed and preserves its cause", () => {
  const cause = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  const repo = openArtifactRepoWithProcess(
    makeTempDir("secant-artifacts-"),
    createFakeProcess({
      syncCommands: [{ result: { kind: "spawn-error", cause } }],
    }),
  );
  const result = repo.stageCommit("a1", [], [output("text", "hi")], AT);
  assert.ok(!result.ok);
  assert.deepEqual(result.problem, {
    kind: "git-unavailable",
    detail: "the `git` executable could not be started",
    cause,
  });
});

test("a signalled Git stage is typed and a signalled read never means absent", () => {
  const process = createFakeProcess({
    syncCommands: [
      { result: { kind: "signal" } },
      { result: { kind: "signal" } },
    ],
  });
  const repo = openArtifactRepoWithProcess(
    makeTempDir("secant-artifacts-"),
    process,
  );
  const staged = repo.stageCommit("a1", [], [output("text", "hi")], AT);
  assert.ok(!staged.ok);
  assert.deepEqual(staged.problem, {
    kind: "git-unavailable",
    detail: "git init terminated by a signal.",
  });
  assert.throws(
    () => repo.read("0".repeat(40), "text"),
    /git cat-file terminated by a signal/,
  );
});
