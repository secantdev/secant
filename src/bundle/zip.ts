import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import type { BundleFinding } from "./manifest.js";
import { normalizeRelativePath } from "./relative-path.js";

// A deterministic ZIP-container writer for `.wfb` bytes. Files only, sorted by
// path, with a fixed DOS timestamp and fixed permissions, so the same entries
// always produce the same bytes and therefore the same digest. Entry data is
// DEFLATE-compressed with node:zlib (compression method 8). This is the "small
// cohesive Secant file" the ticket earns over a library: OpenCode reaches for
// @zip.js/zip.js only in its browser-facing desktop package (Blob APIs) and
// prefers node:zlib in its Node server, and byte-exact reproducibility is far
// easier to guarantee with a writer we control than with a streaming library.

export interface ZipEntry {
  /** Forward-slash relative path stored in the archive. */
  readonly path: string;
  readonly data: Uint8Array;
}

// 1980-01-01 00:00:00, the earliest a DOS timestamp can express; fixing it keeps
// output independent of when the build ran.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const VERSION_MADE_BY = (3 << 8) | 20; // unix host, ZIP 2.0
const VERSION_NEEDED = 20; // deflate
const FLAG_UTF8 = 0x0800;
const METHOD_DEFLATE = 8;
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0; // regular file, rw-r--r--

/** Serialize entries into deterministic ZIP bytes. */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  // ponytail: code-unit sort; archive paths are ASCII, so this equals a UTF-8
  // byte sort. Switch to Buffer.compare of the encoded names if that changes.
  const sorted = [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.data);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(EXTERNAL_ATTRS, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // central-directory disk
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, ...centrals, eocd]);
}

// --- constrained reader ----------------------------------------------------

// The counterpart to writeZip: a reader for untrusted `.wfb` archives. It is not
// a general ZIP library — it enforces Secant-owned archive rules regardless of
// how the archive was produced (#9): UTF-8 relative paths, regular files only,
// no absolute or traversing paths, no links or special files, no duplicate or
// case-colliding paths, no encryption, no multipart archive, and no compression
// other than store and deflate. Budgets on input bytes, expanded bytes, and
// entry count are enforced before and during extraction; a Bundle can never
// raise them. The central directory is authoritative; each entry's exact bytes
// are inflated and verified against its declared size and CRC.

export interface Budgets {
  readonly maxInputBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxEntries: number;
}

// ponytail: generous fixed ceilings for a Workflow Bundle (a manifest, prompts,
// schemas, scripts, small skills). Raise here — never from a Bundle — if a real
// Bundle legitimately needs more.
export const DEFAULT_BUDGETS: Budgets = {
  maxInputBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxEntries: 4096,
};

export type ZipReadResult =
  | { readonly ok: true; readonly entries: readonly ZipEntry[] }
  | { readonly ok: false; readonly finding: BundleFinding };

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORE = 0;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const DOS_DIRECTORY = 0x10;

// Zip64 markers (D6). A Bundle is never a Zip64 archive; reject one explicitly
// rather than let it fail incidentally as `corrupt-archive`/`expanded-too-large`
// downstream. These are the end-of-central-directory record and its locator
// signatures, the `0x0001` extra-field id, and the sentinels a 16-bit count or a
// 32-bit size/offset carries to say the true value lives in a Zip64 record.
const SIG_ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP64_U16 = 0xffff;
const ZIP64_U32 = 0xffffffff;

const UTF8 = new TextDecoder("utf8", { fatal: true });

/** Read and validate untrusted archive bytes into entries, or a finding. */
export function readZip(bytes: Uint8Array, budgets: Budgets): ZipReadResult {
  try {
    return { ok: true, entries: readEntries(Buffer.from(bytes), budgets) };
  } catch (error) {
    if (error instanceof ArchiveError)
      return { ok: false, finding: error.finding };
    throw error;
  }
}

class ArchiveError extends Error {
  constructor(readonly finding: BundleFinding) {
    super(finding.message);
  }
}
function reject(code: string, message: string, path?: string): never {
  throw new ArchiveError({ code, message, ...(path ? { path } : {}) });
}
function rejectZip64(path?: string): never {
  reject(
    "zip64-unsupported",
    path === undefined
      ? "The archive uses the Zip64 format; a Bundle is never a Zip64 archive."
      : `Entry "${path}" uses the Zip64 format; a Bundle is never a Zip64 archive.`,
    path,
  );
}

// True when a central-directory extra field carries the Zip64 header id.
function hasZip64ExtraField(
  buffer: Buffer,
  start: number,
  length: number,
): boolean {
  for (let cursor = start; cursor + 4 <= start + length;) {
    const id = buffer.readUInt16LE(cursor);
    if (id === ZIP64_EXTRA_ID) return true;
    cursor += 4 + buffer.readUInt16LE(cursor + 2);
  }
  return false;
}

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compSize: number;
  readonly uncompSize: number;
  readonly localOffset: number;
}

function readEntries(buffer: Buffer, budgets: Budgets): ZipEntry[] {
  if (buffer.length > budgets.maxInputBytes) {
    reject(
      "archive-too-large",
      `Archive is ${buffer.length} bytes, over the ${budgets.maxInputBytes}-byte input budget.`,
    );
  }

  const eocd = findEocd(buffer);
  // Zip64 (D6): its locator sits immediately before the EOCD, and a sentinel in
  // the EOCD's counts, size, or offset says the true value lives in a Zip64
  // record. Reject either before parsing the central directory as 32-bit.
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
    rejectZip64();
  }
  const diskNo = buffer.readUInt16LE(eocd + 4);
  const cdStartDisk = buffer.readUInt16LE(eocd + 6);
  const cdRecordsThisDisk = buffer.readUInt16LE(eocd + 8);
  const total = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  let cursor = buffer.readUInt32LE(eocd + 16);
  if (
    total === ZIP64_U16 ||
    cdRecordsThisDisk === ZIP64_U16 ||
    centralSize === ZIP64_U32 ||
    cursor === ZIP64_U32
  ) {
    rejectZip64();
  }
  if (diskNo !== 0 || cdStartDisk !== 0 || cdRecordsThisDisk !== total) {
    reject("multipart-archive", "A Bundle must be a single-part archive.");
  }
  if (total > budgets.maxEntries) {
    reject(
      "too-many-entries",
      `Archive declares ${total} entries, over the ${budgets.maxEntries}-entry budget.`,
    );
  }

  const centrals: CentralEntry[] = [];
  const names = new Set<string>();
  const folded = new Set<string>();
  let expected = 0;
  for (let i = 0; i < total; i++) {
    if (
      cursor + 46 > buffer.length ||
      buffer.readUInt32LE(cursor) !== SIG_CENTRAL
    ) {
      reject("corrupt-archive", "The central directory is malformed.");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const uncompSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttrs = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    // Bound the name AND the extra field against the real buffer before either is
    // read: nameLen and extraLen are attacker-controlled, so an overrun must be a
    // `corrupt-archive` finding, never an uncaught RangeError from the reads below
    // (readZip only translates ArchiveError).
    if (nameStart + nameLen + extraLen > buffer.length) {
      reject(
        "corrupt-archive",
        "A central directory entry runs past the archive.",
      );
    }
    const name = decodePath(buffer.subarray(nameStart, nameStart + nameLen));

    if (
      compSize === ZIP64_U32 ||
      uncompSize === ZIP64_U32 ||
      localOffset === ZIP64_U32 ||
      diskStart === ZIP64_U16 ||
      hasZip64ExtraField(buffer, nameStart + nameLen, extraLen)
    ) {
      rejectZip64(name);
    }
    if (diskStart !== 0) {
      reject("multipart-archive", "A Bundle must be a single-part archive.");
    }
    if (flags & FLAG_ENCRYPTED) {
      reject(
        "encrypted-archive",
        `Entry "${name}" is encrypted; a Bundle is never encrypted.`,
        name,
      );
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      reject(
        "unsupported-compression",
        `Entry "${name}" uses compression method ${method}; only store and deflate are allowed.`,
        name,
      );
    }
    checkRegularFile(name, externalAttrs);
    if (names.has(name)) {
      reject("duplicate-path", `Entry "${name}" appears more than once.`, name);
    }
    const lower = name.toLowerCase();
    if (folded.has(lower)) {
      reject(
        "case-colliding-path",
        `Entry "${name}" case-collides with another entry.`,
        name,
      );
    }
    names.add(name);
    folded.add(lower);

    expected += uncompSize;
    if (expected > budgets.maxExpandedBytes) {
      reject(
        "expanded-too-large",
        `Archive expands to over the ${budgets.maxExpandedBytes}-byte budget.`,
      );
    }
    centrals.push({ name, method, crc, compSize, uncompSize, localOffset });
    cursor = nameStart + nameLen + extraLen + commentLen;
  }

  return centrals.map((entry) => ({
    path: entry.name,
    data: extract(buffer, entry),
  }));
}

// Regular files only: reject a trailing-slash directory name, the DOS directory
// attribute, and any Unix mode whose type is not a regular file (symlink,
// device, fifo, socket). A zero external-attrs (a DOS archive with no Unix mode)
// carries no type and is treated as a regular file.
function checkRegularFile(name: string, externalAttrs: number): void {
  if (name.endsWith("/") || externalAttrs & DOS_DIRECTORY) {
    reject(
      "directory-entry",
      `Entry "${name}" is a directory; a Bundle archives regular files only.`,
      name,
    );
  }
  const unixMode = (externalAttrs >>> 16) & 0xffff;
  if (unixMode !== 0 && (unixMode & S_IFMT) !== S_IFREG) {
    reject(
      "irregular-file",
      `Entry "${name}" is not a regular file (link or special file); a Bundle archives regular files only.`,
      name,
    );
  }
}

function extract(buffer: Buffer, entry: CentralEntry): Uint8Array {
  const offset = entry.localOffset;
  if (
    offset + 30 > buffer.length ||
    buffer.readUInt32LE(offset) !== SIG_LOCAL
  ) {
    reject(
      "corrupt-archive",
      `Entry "${entry.name}" has no local header.`,
      entry.name,
    );
  }
  const nameLen = buffer.readUInt16LE(offset + 26);
  const extraLen = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;
  if (dataStart + entry.compSize > buffer.length) {
    reject(
      "corrupt-archive",
      `Entry "${entry.name}" data runs past the archive.`,
      entry.name,
    );
  }
  const compressed = buffer.subarray(dataStart, dataStart + entry.compSize);
  let data: Buffer;
  if (entry.method === METHOD_STORE) {
    data = Buffer.from(compressed);
  } else {
    try {
      // Cap the inflated output at the declared size so a decompression bomb —
      // a tiny declared size hiding a stream that expands to gigabytes — throws
      // instead of allocating past the budget. zlib throws once output would
      // exceed the limit; the size/CRC check below still confirms the exact
      // bytes. `|| 1` keeps a legitimately empty entry from a zero limit.
      data = inflateRawSync(compressed, {
        maxOutputLength: entry.uncompSize || 1,
      });
    } catch {
      reject(
        "corrupt-entry",
        `Entry "${entry.name}" could not be decompressed within its declared size.`,
        entry.name,
      );
    }
  }
  // Enforce the declared size during extraction (a bomb that lies is caught) and
  // verify the CRC so the exact bytes are trusted.
  if (data.length !== entry.uncompSize || crc32(data) >>> 0 !== entry.crc) {
    reject(
      "corrupt-entry",
      `Entry "${entry.name}" does not match its declared size or checksum.`,
      entry.name,
    );
  }
  return data;
}

function decodePath(raw: Buffer): string {
  let name: string;
  try {
    name = UTF8.decode(raw);
  } catch {
    reject("non-utf8-path", "An archive entry name is not valid UTF-8.");
  }
  const safe = normalizeRelativePath(name);
  if (safe === undefined) {
    reject(
      "unsafe-path",
      `Entry "${name}" is an absolute or traversing path; a Bundle stores relative paths only.`,
      name,
    );
  }
  return safe;
}

// Scan backward for the End Of Central Directory record. Our own writer emits no
// comment, but a foreign archive may, so accept a trailing comment of the length
// the record declares.
function findEocd(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (
      buffer.readUInt32LE(i) === SIG_EOCD &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      return i;
    }
  }
  reject(
    "corrupt-archive",
    "No end-of-central-directory record; not a ZIP archive.",
  );
}
