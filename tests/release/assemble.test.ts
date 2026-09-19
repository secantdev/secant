import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CHECKSUMS_FILE,
  LICENSE_FILE,
  MANIFEST_FILE,
  NOTICES_FILE,
  type CandidateManifest,
  assertAgrees,
  computeCandidate,
  sha256,
} from "../../scripts/assemble.js";
import { verifyReleaseArchive } from "../../scripts/release-consumer.js";
import { TARGETS } from "../../scripts/targets.js";
import { makeTempDir } from "../helpers/tempDir.js";

// These tests exercise the pure assembly and pre-extraction verification logic
// only, and spawn NO subprocess. The archive create → extract → run round-trip
// (archive names/types, layout, executable mode, native --version, macOS ad-hoc
// signature) is proven end-to-end, on real binaries, by the three-OS
// `release-archive-consumer` CI job (docs/agents/testing.md). It is deliberately
// kept out of the deterministic `bun test` suite because spawning archive tools
// in the parallel pool adds a concurrent first-spawn worker that tips over the
// Bun 1.4.2 child-lifecycle defect on the CPU-constrained Linux runner (#149).

const VERSION = "9.9.9-test";

/** A fake project tree: package.json, legal material, and one stand-in binary
 *  per gated target under dist/ (plain bytes, never executed here). The bytes
 *  differ per target, so each carries a distinct digest — what the manifest
 *  must record. */
function makeProject(version = VERSION): string {
  const root = makeTempDir("secant-assemble-project-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@secantdev/secant", version }, null, 2),
  );
  writeFileSync(join(root, LICENSE_FILE), "Secant test LICENSE\n");
  writeFileSync(join(root, NOTICES_FILE), "Secant test third-party notices\n");
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  for (const [key, target] of Object.entries(TARGETS)) {
    writeFileSync(join(dist, target.outfile), `stand-in binary for ${key}\n`);
  }
  return root;
}

test("computeCandidate carries every owned target fact and a digest", () => {
  const manifest = computeCandidate({ projectRoot: makeProject() });

  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.targets.length, Object.keys(TARGETS).length);
  assert.match(manifest.licenseSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.noticesSha256, /^[0-9a-f]{64}$/);

  for (const [key, target] of Object.entries(TARGETS)) {
    const emitted = manifest.targets.find((candidate) => candidate.key === key);
    assert.ok(emitted, `manifest is missing target ${key}`);
    // AC1: OS, CPU, archive name/type, inner executable, and package identity
    // all travel through the one manifest.
    assert.equal(emitted.os, target.os);
    assert.equal(emitted.cpu, target.cpu);
    assert.equal(emitted.package, target.package);
    assert.equal(emitted.archive, target.archive);
    assert.equal(emitted.archiveType, target.archiveType);
    assert.equal(emitted.executable, target.executable);
    assert.match(emitted.binarySha256, /^[0-9a-f]{64}$/);
  }
});

test("computeCandidate fails closed when a candidate binary is missing", () => {
  const root = makeProject();
  rmSync(join(root, "dist", TARGETS["linux-x64"].outfile));
  assert.throws(
    () => computeCandidate({ projectRoot: root }),
    /Candidate binary missing/,
  );
});

test("assertAgrees rejects version, identity, and binary-digest disagreement", () => {
  const base = computeCandidate({ projectRoot: makeProject() });
  const clone = (): CandidateManifest =>
    JSON.parse(JSON.stringify(base)) as CandidateManifest;

  // Equal candidates agree.
  assert.doesNotThrow(() => assertAgrees(base, clone()));

  // A changed version is rejected.
  const bumped = clone();
  (bumped as { version: string }).version = "9.9.10-test";
  assert.throws(() => assertAgrees(base, bumped), /version disagreement/);

  // A rebuilt input (different digest) is rejected — assembly never rebuilds.
  const rebuilt = clone();
  (rebuilt.targets[0] as { binarySha256: string }).binarySha256 = "0".repeat(
    64,
  );
  assert.throws(
    () => assertAgrees(base, rebuilt),
    /binary digest disagreement/,
  );

  // A changed identity fact (here the inner executable name) is rejected.
  const renamed = clone();
  (renamed.targets[0] as { executable: string }).executable = "renamed";
  assert.throws(() => assertAgrees(base, renamed), /identity disagreement/);

  // A dropped target is rejected.
  const dropped = clone();
  dropped.targets.pop();
  assert.throws(() => assertAgrees(base, dropped), /identity disagreement/);
});

/** A release directory holding one target's manifest, a stand-in archive whose
 *  digest matches the manifest, and a SHA256SUMS. No real archive is created. */
function makeReleaseDir(): {
  dir: string;
  archivePath: string;
  archive: string;
} {
  const manifest = computeCandidate({ projectRoot: makeProject() });
  const dir = makeTempDir("secant-release-dir-");
  const target = manifest.targets.find((t) => t.key === "linux-x64");
  assert.ok(target);
  const archivePath = join(dir, target.archive);
  writeFileSync(archivePath, "stand-in archive bytes");
  target.archiveSha256 = sha256(archivePath);
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest));
  writeFileSync(
    join(dir, CHECKSUMS_FILE),
    `${manifest.targets.map((t) => `${t.archiveSha256}  ${t.archive}`).join("\n")}\n`,
  );
  return { dir, archivePath, archive: target.archive };
}

test("the consumer refuses an archive that is not in the manifest", () => {
  const { dir } = makeReleaseDir();
  const stray = join(dir, "secant-unknown.zip");
  writeFileSync(stray, "not a candidate");
  assert.throws(
    () => verifyReleaseArchive({ archive: stray, native: false }),
    /not a candidate archive/,
  );
});

test("the consumer refuses a tampered archive digest", () => {
  const { archivePath } = makeReleaseDir();
  appendFileSync(archivePath, "tamper");
  assert.throws(
    () => verifyReleaseArchive({ archive: archivePath, native: false }),
    /does not match the candidate manifest/,
  );
});

test("the consumer requires SHA256SUMS beside the manifest", () => {
  const { dir, archivePath } = makeReleaseDir();
  rmSync(join(dir, CHECKSUMS_FILE));
  assert.throws(
    () => verifyReleaseArchive({ archive: archivePath, native: false }),
    new RegExp(`${CHECKSUMS_FILE} is missing`),
  );
});

test("the consumer refuses a malformed manifest", () => {
  const { dir, archivePath } = makeReleaseDir();
  writeFileSync(join(dir, MANIFEST_FILE), "{}");
  assert.throws(
    () => verifyReleaseArchive({ archive: archivePath, native: false }),
    /Malformed candidate manifest/,
  );
});
