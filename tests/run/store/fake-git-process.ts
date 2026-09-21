import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ProcessAdapter,
  SpawnSyncOptions,
  SpawnSyncResult,
} from "../../../src/process/process.js";
import { createFakeProcess } from "../../process/fake-adapter.js";
import { openRunGroup, type RunGroup } from "../../../src/run/store/store.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakeGitRepository {
  readonly blobs: Map<string, Uint8Array>;
  readonly trees: Map<string, ReadonlyMap<string, string>>;
  readonly commits: Map<string, string>;
}

export function createFakeGitProcess(): ProcessAdapter {
  const repository: FakeGitRepository = {
    blobs: new Map(),
    trees: new Map(),
    commits: new Map(),
  };
  return createFakeProcess({
    syncCommandHandler: (options) => runGit(repository, options),
  });
}

export function createUnavailableGitProcess(): ProcessAdapter {
  return createFakeProcess({
    syncCommandHandler: () => ({
      kind: "spawn-error",
      cause: Object.assign(new Error("git not found"), { code: "ENOENT" }),
    }),
  });
}

type RunGroupOptions = Omit<
  NonNullable<Parameters<typeof openRunGroup>[2]>,
  "process"
>;

const sharedFakeGitProcess = createFakeGitProcess();

export function openFakeRunGroup(
  home: string,
  workspace: string,
  options: RunGroupOptions = {},
): RunGroup {
  return openRunGroup(home, workspace, {
    ...options,
    process: sharedFakeGitProcess,
  });
}

function runGit(
  repository: FakeGitRepository,
  options: SpawnSyncOptions,
): SpawnSyncResult {
  if (options.executable !== "git") {
    throw new Error(`fake Git received executable ${options.executable}`);
  }
  const [command, ...args] = options.args;
  switch (command) {
    case "init":
      return exited();
    case "update-ref":
      return writeReference(options);
    case "hash-object":
      return writeBlob(repository, options.input ?? new Uint8Array());
    case "mktree":
      return writeTree(repository, options.input ?? new Uint8Array());
    case "commit-tree":
      return writeCommit(repository, args, options.env);
    case "cat-file":
      return readBlob(repository, args);
    default:
      throw new Error(`fake Git received unsupported command ${command}`);
  }
}

function writeReference(options: SpawnSyncOptions): SpawnSyncResult {
  const gitDirectory = options.env.GIT_DIR;
  const reference = options.args[1];
  const value = options.args[2];
  if (
    gitDirectory !== undefined &&
    reference !== undefined &&
    value !== undefined
  ) {
    const path = join(gitDirectory, ...reference.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${value}\n`);
  }
  return exited();
}

function writeBlob(
  repository: FakeGitRepository,
  bytes: Uint8Array,
): SpawnSyncResult {
  const id = digest(bytes);
  repository.blobs.set(id, Uint8Array.from(bytes));
  return exited(`${id}\n`);
}

function writeTree(
  repository: FakeGitRepository,
  bytes: Uint8Array,
): SpawnSyncResult {
  const text = decoder.decode(bytes);
  const entries = new Map<string, string>();
  for (const line of text.trimEnd().split("\n")) {
    if (line.length === 0) continue;
    const match = /^100644 blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match === null) return exited("", 1, "invalid tree\n");
    entries.set(match[2]!, match[1]!);
  }
  const id = digest(bytes);
  repository.trees.set(id, entries);
  return exited(`${id}\n`);
}

function writeCommit(
  repository: FakeGitRepository,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): SpawnSyncResult {
  const tree = args[0];
  if (tree === undefined || !repository.trees.has(tree)) {
    return exited("", 1, "unknown tree\n");
  }
  const id = digest(
    encoder.encode(
      [
        tree,
        args.join("\0"),
        environment.GIT_AUTHOR_DATE ?? "",
        environment.GIT_COMMITTER_DATE ?? "",
      ].join("\0"),
    ),
  );
  repository.commits.set(id, tree);
  return exited(`${id}\n`);
}

function readBlob(
  repository: FakeGitRepository,
  args: readonly string[],
): SpawnSyncResult {
  const reference = args[1];
  const separator = reference?.indexOf(":") ?? -1;
  if (reference === undefined || separator < 1) return exited("", 1);
  const commit = reference.slice(0, separator);
  const name = reference.slice(separator + 1);
  const tree = repository.commits.get(commit);
  const blob =
    tree === undefined ? undefined : repository.trees.get(tree)?.get(name);
  const bytes = blob === undefined ? undefined : repository.blobs.get(blob);
  return bytes === undefined
    ? exited("", 1)
    : {
        kind: "exited",
        status: 0,
        stdout: Uint8Array.from(bytes),
        stderr: new Uint8Array(),
      };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function exited(stdout = "", status = 0, stderr = ""): SpawnSyncResult {
  return {
    kind: "exited",
    status,
    stdout: encoder.encode(stdout),
    stderr: encoder.encode(stderr),
  };
}
