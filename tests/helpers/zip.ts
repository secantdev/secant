import { inflateRawSync } from "node:zlib";

// A test-only reader for the deterministic archives `writeZip` produces (no data
// descriptors, store or deflate). Production code reads archives through the
// Bundle Module's `readBundle`/`inspectBundle`; the constrained `readZip` is not
// part of the entry (audit A9), so a fixture that needs to inspect or repack raw
// bytes walks the local headers here instead.

export interface ArchiveEntry {
  path: string;
  data: Buffer;
}

const SIG_LOCAL = 0x04034b50;
const METHOD_STORE = 0;

/** Every entry of a deterministic archive, decompressed. */
export function readArchiveEntries(bytes: Uint8Array): ArchiveEntry[] {
  const buffer = Buffer.from(bytes);
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  while (
    offset + 30 <= buffer.length &&
    buffer.readUInt32LE(offset) === SIG_LOCAL
  ) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const path = buffer
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.push({
      path,
      data: method === METHOD_STORE ? Buffer.from(raw) : inflateRawSync(raw),
    });
    offset = dataStart + compressedSize;
  }
  return entries;
}
