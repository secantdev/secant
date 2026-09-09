import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import { buildBundle } from "../../src/bundle/bundle.js";
import { makeTempDir } from "../helpers/tempDir.js";

const proofBundle = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bundles",
  "test-repair-workflow",
);

function authoringFolder(
  manifest: unknown,
  files: Record<string, string> = {},
): string {
  const dir = makeTempDir("secant-bundle-");
  writeFileSync(
    join(dir, "manifest.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2),
  );
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function base(): Record<string, unknown> {
  return {
    formatVersion: 1,
    bundle: {
      id: "io.example.sample",
      version: "1.0.0",
      name: "Sample",
      description: "A sample.",
    },
    inputs: {},
    assets: [],
    routing: [],
  };
}

/** Inflate one entry's bytes from the deterministic ZIP the builder writes. */
function readZipEntry(bytes: Uint8Array, name: string): Buffer {
  const buffer = Buffer.from(bytes);
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const entryName = buffer
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (entryName === name) return inflateRawSync(data);
    offset = dataStart + compressedSize;
  }
  throw new Error(`Entry ${name} not found in archive.`);
}

test("building the Proof Bundle yields its identity and a sha-256 digest", () => {
  const outcome = buildBundle(proofBundle);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.deepEqual(outcome.built.identity, {
    id: "dev.secant.test-repair",
    version: "1.0.0",
  });
  assert.match(outcome.built.digest, /^[0-9a-f]{64}$/);
});

test("the packaged manifest gets the derived engine range and canonical platforms", () => {
  const outcome = buildBundle(proofBundle);
  assert.ok(outcome.ok);
  const manifest = JSON.parse(
    readZipEntry(outcome.built.bytes, "manifest.json").toString("utf8"),
  );
  assert.equal(manifest.requires.engine, ">=0.1.0");
  assert.deepEqual(manifest.platforms, ["windows", "macos", "linux"]);
});

test("building the same folder twice is byte-identical and leaves it unchanged", () => {
  const before = readFileSync(join(proofBundle, "manifest.json"));
  const first = buildBundle(proofBundle);
  const second = buildBundle(proofBundle);
  assert.ok(first.ok && second.ok);
  assert.equal(Buffer.compare(first.built.bytes, second.built.bytes), 0);
  assert.equal(first.built.digest, second.built.digest);
  assert.equal(
    Buffer.compare(readFileSync(join(proofBundle, "manifest.json")), before),
    0,
  );
});

test("an omitted platforms becomes the build host; an authored subset is preserved", () => {
  const host = { win32: "windows", darwin: "macos", linux: "linux" }[
    process.platform as "win32" | "darwin" | "linux"
  ];
  const omitted = buildBundle(authoringFolder(base()));
  assert.ok(omitted.ok);
  const inserted = JSON.parse(
    readZipEntry(omitted.built.bytes, "manifest.json").toString("utf8"),
  );
  assert.deepEqual(inserted.platforms, [host]);

  const authored = buildBundle(
    authoringFolder({ ...base(), platforms: ["linux", "macos"] }),
  );
  assert.ok(authored.ok);
  const kept = JSON.parse(
    readZipEntry(authored.built.bytes, "manifest.json").toString("utf8"),
  );
  assert.deepEqual(kept.platforms, ["macos", "linux"]);
});

const rejections: ReadonlyArray<{
  readonly title: string;
  readonly folder: () => string;
  readonly code: string;
  readonly path: string;
}> = [
  {
    title: "an unknown top-level field",
    folder: () => authoringFolder({ ...base(), surprise: true }),
    code: "unknown-field",
    path: "surprise",
  },
  {
    title: "an unknown nested field",
    folder: () =>
      authoringFolder({
        ...base(),
        bundle: { ...(base().bundle as object), extra: 1 },
      }),
    code: "unknown-field",
    path: "bundle.extra",
  },
  {
    title: "a malformed id",
    folder: () =>
      authoringFolder({
        ...base(),
        bundle: { ...(base().bundle as object), id: "Not_Reverse_Domain" },
      }),
    code: "invalid-bundle-id",
    path: "bundle.id",
  },
  {
    title: "a malformed version",
    folder: () =>
      authoringFolder({
        ...base(),
        bundle: { ...(base().bundle as object), version: "1.0" },
      }),
    code: "invalid-bundle-version",
    path: "bundle.version",
  },
  {
    title: "an asset-kind mismatch",
    folder: () =>
      authoringFolder(
        { ...base(), assets: [{ path: "note.md", kind: "schema" }] },
        { "note.md": "x" },
      ),
    code: "asset-kind-mismatch",
    path: "note.md",
  },
  {
    title: "an entry outside every declared asset tree",
    folder: () => authoringFolder(base(), { "stray.txt": "x" }),
    code: "unclaimed-entry",
    path: "stray.txt",
  },
  {
    title: "overlapping asset trees",
    folder: () =>
      authoringFolder(
        {
          ...base(),
          assets: [
            { path: "lib", kind: "resource" },
            { path: "lib/a.txt", kind: "script" },
          ],
        },
        { "lib/a.txt": "x" },
      ),
    code: "overlapping-asset-trees",
    path: "lib/a.txt",
  },
  {
    title: "an absolute command executable",
    folder: () =>
      authoringFolder({
        ...base(),
        routing: [
          {
            id: "c",
            kind: "command",
            command: { executable: "/bin/sh", arguments: [] },
          },
        ],
      }),
    code: "invalid-command-executable",
    path: "routing[0].command.executable",
  },
  {
    title: "a shell-shaped command executable",
    folder: () =>
      authoringFolder({
        ...base(),
        routing: [
          {
            id: "c",
            kind: "command",
            command: { executable: "sh -c 'x'", arguments: [] },
          },
        ],
      }),
    code: "invalid-command-executable",
    path: "routing[0].command.executable",
  },
];

for (const rejection of rejections) {
  test(`rejects ${rejection.title} with a distinct Problem`, () => {
    const outcome = buildBundle(rejection.folder());
    assert.ok(!outcome.ok, `expected ${rejection.code}`);
    assert.equal(outcome.finding.code, rejection.code);
    assert.equal(outcome.finding.path, rejection.path);
  });
}
