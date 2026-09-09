import { crc32, deflateRawSync } from "node:zlib";

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
