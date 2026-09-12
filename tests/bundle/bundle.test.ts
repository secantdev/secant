import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildBundle,
  DEFAULT_BUDGETS,
  readBundle,
  writeZip,
  type Budgets,
  type ZipEntry,
} from "../../src/bundle/bundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { readArchiveEntries } from "../helpers/zip.js";

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

/** One entry's decompressed bytes from the deterministic ZIP the builder writes. */
function readZipEntry(bytes: Uint8Array, name: string): Buffer {
  const entry = readArchiveEntries(bytes).find((e) => e.path === name);
  if (!entry) throw new Error(`Entry ${name} not found in archive.`);
  return entry.data;
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
    assert.ok("finding" in outcome, `expected a validation finding`);
    assert.equal(outcome.finding.code, rejection.code);
    assert.equal(outcome.finding.path, rejection.path);
  });
}

test("a shape-valid but non-composing folder fails the build with its findings", () => {
  const outcome = buildBundle(
    authoringFolder(
      {
        ...base(),
        assets: [{ path: "p.md", kind: "prompt" }],
        routing: [
          {
            repeat: {
              until: "never-bound",
              reviewCheckpoint: { interval: 1, message: "continue?" },
              steps: [
                {
                  id: "a",
                  kind: "agent",
                  session: "s",
                  prompt: { asset: "p.md" },
                },
              ],
            },
          },
        ],
      },
      { "p.md": "do the work" },
    ),
  );
  assert.ok(!outcome.ok);
  assert.ok("composition" in outcome, "expected composition findings");
  assert.deepEqual(
    outcome.composition.map((finding) => finding.code),
    ["verdict-unbound-before-entry"],
  );
});

// --- constrained reader and install validation (readBundle) -----------------

function proofBytes(): Uint8Array {
  const outcome = buildBundle(proofBundle);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome.built.bytes;
}

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

// Round-trip a real archive's entries through the reader and writer, replacing
// one entry, so a tampered-but-well-formed archive can be built for a test.
function repack(
  bytes: Uint8Array,
  replace: (entries: readonly ZipEntry[]) => ZipEntry[],
): Uint8Array {
  return writeZip(replace(readArchiveEntries(bytes)));
}

// Overwrite the general-purpose flag and method in both the local and central
// header of a single-entry archive, so an otherwise-valid archive can carry an
// unsupported shape a writer never emits.
function corruptSingleEntry(
  bytes: Uint8Array,
  patch: { flags?: number; method?: number },
): Uint8Array {
  const buffer = Buffer.from(bytes);
  const nameLen = buffer.readUInt16LE(26);
  const compSize = buffer.readUInt32LE(18);
  const central = 30 + nameLen + compSize;
  if (patch.flags !== undefined) {
    buffer.writeUInt16LE(patch.flags, 6);
    buffer.writeUInt16LE(patch.flags, central + 8);
  }
  if (patch.method !== undefined) {
    buffer.writeUInt16LE(patch.method, 8);
    buffer.writeUInt16LE(patch.method, central + 10);
  }
  return buffer;
}

test("readBundle accepts real Proof Bundle bytes with its identity and digest", () => {
  const built = buildBundle(proofBundle);
  assert.ok(built.ok);
  const outcome = readBundle(built.built.bytes, DEFAULT_BUDGETS);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.deepEqual(outcome.read.identity, built.built.identity);
  assert.equal(outcome.read.digest, built.built.digest);
});

const archiveRejections: {
  name: string;
  bytes: () => Uint8Array;
  budgets?: Budgets;
  code: string;
}[] = [
  {
    name: "an absolute or traversing path",
    bytes: () => writeZip([{ path: "../evil.txt", data: Buffer.from("x") }]),
    code: "unsafe-path",
  },
  {
    name: "a directory entry",
    bytes: () => writeZip([{ path: "dir/", data: Buffer.alloc(0) }]),
    code: "directory-entry",
  },
  {
    name: "a duplicate path",
    bytes: () =>
      writeZip([
        { path: "a.txt", data: Buffer.from("1") },
        { path: "a.txt", data: Buffer.from("2") },
      ]),
    code: "duplicate-path",
  },
  {
    name: "a case-colliding path",
    bytes: () =>
      writeZip([
        { path: "a.txt", data: Buffer.from("1") },
        { path: "A.txt", data: Buffer.from("2") },
      ]),
    code: "case-colliding-path",
  },
  {
    name: "an encrypted entry",
    bytes: () =>
      corruptSingleEntry(
        writeZip([{ path: "note.txt", data: Buffer.from("x") }]),
        { flags: 0x0801 },
      ),
    code: "encrypted-archive",
  },
  {
    name: "an unsupported compression method",
    bytes: () =>
      corruptSingleEntry(
        writeZip([{ path: "note.txt", data: Buffer.from("x") }]),
        { method: 99 },
      ),
    code: "unsupported-compression",
  },
  {
    name: "a multipart archive",
    bytes: () => {
      const buffer = Buffer.from(
        writeZip([{ path: "note.txt", data: Buffer.from("x") }]),
      );
      buffer.writeUInt16LE(1, buffer.length - 22 + 4); // this-disk number
      return buffer;
    },
    code: "multipart-archive",
  },
  {
    name: "an over-budget input size",
    bytes: () => writeZip([{ path: "note.txt", data: Buffer.from("x") }]),
    budgets: { ...DEFAULT_BUDGETS, maxInputBytes: 1 },
    code: "archive-too-large",
  },
  {
    name: "an over-budget entry count",
    bytes: () =>
      writeZip([
        { path: "a.txt", data: Buffer.from("1") },
        { path: "b.txt", data: Buffer.from("2") },
      ]),
    budgets: { ...DEFAULT_BUDGETS, maxEntries: 1 },
    code: "too-many-entries",
  },
  {
    name: "an over-budget expanded size",
    bytes: () => writeZip([{ path: "a.txt", data: Buffer.from("hello") }]),
    budgets: { ...DEFAULT_BUDGETS, maxExpandedBytes: 1 },
    code: "expanded-too-large",
  },
  {
    // Zip64 (D6): a 0xFFFFFFFF size sentinel says the true size lives in a Zip64
    // record; before, this failed incidentally as corrupt/expanded-too-large.
    name: "a Zip64 size sentinel in the central directory",
    bytes: () => {
      const buffer = Buffer.from(
        writeZip([{ path: "note.txt", data: Buffer.from("x") }]),
      );
      const nameLen = buffer.readUInt16LE(26);
      const compSize = buffer.readUInt32LE(18);
      const central = 30 + nameLen + compSize;
      buffer.writeUInt32LE(0xffffffff, central + 24); // uncompressed-size sentinel
      return buffer;
    },
    code: "zip64-unsupported",
  },
  {
    // Zip64 (D6): the end-of-central-directory locator, sitting just before the
    // EOCD, is the other primary Zip64 marker.
    name: "a Zip64 end-of-central-directory locator",
    bytes: () => {
      const buffer = Buffer.from(
        writeZip([{ path: "note.txt", data: Buffer.from("x") }]),
      );
      const eocd = buffer.length - 22;
      buffer.writeUInt32LE(0x07064b50, eocd - 20); // Zip64 EOCD locator signature
      return buffer;
    },
    code: "zip64-unsupported",
  },
  {
    // A central extra-field length that overruns the buffer must be a graceful
    // finding, not an uncaught RangeError from the Zip64 extra-field scan that
    // reads that (attacker-controlled) range.
    name: "a central extra field that runs past the archive",
    bytes: () => {
      const buffer = Buffer.from(
        writeZip([{ path: "note.txt", data: Buffer.from("x") }]),
      );
      const nameLen = buffer.readUInt16LE(26);
      const compSize = buffer.readUInt32LE(18);
      const central = 30 + nameLen + compSize;
      buffer.writeUInt16LE(0xfff0, central + 30); // central extra-field length
      return buffer;
    },
    code: "corrupt-archive",
  },
];

for (const rejection of archiveRejections) {
  test(`readBundle rejects ${rejection.name}`, () => {
    const result = readBundle(
      rejection.bytes(),
      rejection.budgets ?? DEFAULT_BUDGETS,
    );
    assert.ok(!result.ok, "expected a rejection");
    assert.equal(result.finding.code, rejection.code);
  });
}

test("readBundle rejects an archive with no manifest.json", () => {
  const bytes = writeZip([{ path: "note.txt", data: Buffer.from("x") }]);
  const outcome = readBundle(bytes, DEFAULT_BUDGETS);
  assert.ok(!outcome.ok);
  assert.equal(outcome.finding.code, "manifest-missing");
});

test("readBundle rejects an understated engine range", () => {
  const bytes = repack(proofBytes(), (entries) =>
    entries.map((entry) =>
      entry.path === "manifest.json"
        ? {
            path: entry.path,
            data: Buffer.from(
              decode(entry.data).replace('">=0.1.0"', '">=0.0.0"'),
            ),
          }
        : entry,
    ),
  );
  const outcome = readBundle(bytes, DEFAULT_BUDGETS);
  assert.ok(!outcome.ok);
  assert.equal(outcome.finding.code, "engine-understated");
});

test("readBundle rejects a decompression bomb that understates its expanded size", () => {
  // A single entry whose declared uncompressed size is tiny but whose deflate
  // stream really expands to a megabyte: the pre-extraction budget sums the
  // understated size and passes, so the per-entry output cap is what must catch
  // it during inflation.
  const buffer = Buffer.from(
    writeZip([{ path: "bomb.txt", data: Buffer.alloc(1_000_000, 0x41) }]),
  );
  const nameLen = buffer.readUInt16LE(26);
  const compSize = buffer.readUInt32LE(18);
  const central = 30 + nameLen + compSize;
  buffer.writeUInt32LE(10, 22); // local uncompressed size
  buffer.writeUInt32LE(10, central + 24); // central uncompressed size
  const result = readBundle(buffer, DEFAULT_BUDGETS);
  assert.ok(!result.ok, "expected the bomb to be rejected");
  assert.equal(result.finding.code, "corrupt-entry");
});

// The manifest validator's `relativePath` and the ZIP reader's `decodePath` share
// one private helper (D8), so an asset path in a manifest and an entry name in an
// archive accept or reject identically. Drive the two public ingress paths with
// the same inputs and assert they agree on every one.
for (const { input, safe } of [
  { input: "ok/file.txt", safe: true },
  { input: "a\\b.txt", safe: true }, // backslash normalizes to a forward slash
  { input: "../evil.txt", safe: false },
  { input: "/abs.txt", safe: false },
  { input: "C:\\win.txt", safe: false },
]) {
  test(`the relative-path rule agrees on ${JSON.stringify(input)}`, () => {
    // Manifest ingress: the path rule fires in validateManifest (before any file
    // is read), so a bad path is `invalid-field`; a safe one reaches the asset
    // existence check (`asset-not-found`) instead.
    const folder = authoringFolder({
      ...base(),
      assets: [{ path: input, kind: "resource" }],
    });
    const manifest = buildBundle(folder);
    const manifestRejected =
      !manifest.ok &&
      "finding" in manifest &&
      manifest.finding.code === "invalid-field";

    // ZIP ingress: the path rule fires in decodePath; a safe path reaches the
    // manifest-missing check instead.
    const archive = readBundle(
      writeZip([{ path: input, data: Buffer.from("x") }]),
      DEFAULT_BUDGETS,
    );
    const archiveRejected =
      !archive.ok && archive.finding.code === "unsafe-path";

    assert.equal(manifestRejected, !safe, `manifest disagreed on ${input}`);
    assert.equal(archiveRejected, !safe, `archive disagreed on ${input}`);
  });
}
