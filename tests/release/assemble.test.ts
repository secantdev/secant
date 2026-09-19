import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CHECKSUMS_FILE,
  LICENSE_FILE,
  MANIFEST_FILE,
  NOTICES_FILE,
  type CandidateManifest,
  assembleRelease,
} from "../../scripts/assemble.js";
import { verifyReleaseArchive } from "../../scripts/release-consumer.js";
import { TARGETS } from "../../scripts/targets.js";
import { makeTempDir } from "../helpers/tempDir.js";

// Assembly runs on the Linux build job and this test spawns the platform archive
// tools (`zip`/`tar`/`unzip`), which Windows runners do not ship (no `zip`).
// The real cross-OS proof is the `release-archive-consumer` CI matrix; here the
// deterministic assembly and consumer-verification logic is exercised on POSIX.
const posixOnly = process.platform === "win32" ? { skip: true } : {};

const VERSION = "9.9.9-test";
const LICENSE_TEXT = "Secant test LICENSE\n";
const NOTICES_TEXT = "Secant test third-party notices\n";

/** A fake project tree: package.json, legal material, and one runnable stand-in
 *  binary per gated target under dist/ that prints the given version. The bytes
 *  differ per target (the target key is embedded), so each carries a distinct
 *  digest — exactly what the manifest must record. */
function makeProject(options?: {
  version?: string;
  binaryVersion?: string;
}): string {
  const version = options?.version ?? VERSION;
  const binaryVersion = options?.binaryVersion ?? version;
  const root = makeTempDir("secant-assemble-project-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@secantdev/secant", version }, null, 2),
  );
  writeFileSync(join(root, LICENSE_FILE), LICENSE_TEXT);
  writeFileSync(join(root, NOTICES_FILE), NOTICES_TEXT);
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  for (const [key, target] of Object.entries(TARGETS)) {
    const binary = join(dist, target.outfile);
    writeFileSync(
      binary,
      `#!/bin/sh\n# ${key}\nprintf '%s\\n' '${binaryVersion}'\n`,
    );
    chmodSync(binary, 0o755);
  }
  return root;
}

test(
  "assembly emits archives, a manifest, and checksums from the target manifest",
  posixOnly,
  () => {
    const root = makeProject();
    const manifest = assembleRelease({ projectRoot: root });
    const outDir = join(root, "dist", "release");

    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.targets.length, Object.keys(TARGETS).length);

    for (const [key, target] of Object.entries(TARGETS)) {
      const emitted = manifest.targets.find(
        (candidate) => candidate.key === key,
      );
      assert.ok(emitted, `manifest is missing target ${key}`);
      // AC1: every owned fact travels through the one manifest.
      assert.equal(emitted.os, target.os);
      assert.equal(emitted.cpu, target.cpu);
      assert.equal(emitted.package, target.package);
      assert.equal(emitted.archive, target.archive);
      assert.equal(emitted.archiveType, target.archiveType);
      assert.equal(emitted.executable, target.executable);
      assert.match(emitted.binarySha256, /^[0-9a-f]{64}$/);
      assert.match(emitted.archiveSha256, /^[0-9a-f]{64}$/);
      // The archive file itself exists.
      assert.ok(
        readdirSync(outDir).includes(target.archive),
        `${target.archive} was not created`,
      );
    }

    // The manifest and checksums are written and consistent.
    const written: CandidateManifest = JSON.parse(
      readFileSync(join(outDir, MANIFEST_FILE), "utf8"),
    );
    assert.deepEqual(written, manifest);
    const checksums = readFileSync(join(outDir, CHECKSUMS_FILE), "utf8");
    for (const target of manifest.targets) {
      assert.ok(
        checksums.includes(`${target.archiveSha256}  ${target.archive}`),
        `${target.archive} missing from ${CHECKSUMS_FILE}`,
      );
    }
  },
);

test(
  "the consumer verifies layout, legal material, digest, and executable mode",
  posixOnly,
  () => {
    const root = makeProject();
    const manifest = assembleRelease({ projectRoot: root });
    const outDir = join(root, "dist", "release");
    // AC4: structural verification passes for every produced archive.
    for (const target of manifest.targets) {
      verifyReleaseArchive({
        archive: join(outDir, target.archive),
        native: false,
      });
    }
  },
);

test(
  "the consumer runs the extracted binary and checks its version",
  posixOnly,
  () => {
    const root = makeProject();
    assembleRelease({ projectRoot: root });
    const outDir = join(root, "dist", "release");
    // The Linux tar.gz target never triggers codesign, so the native run — and its
    // version assertion — is exercised on any POSIX host.
    verifyReleaseArchive({
      archive: join(outDir, TARGETS["linux-x64"].archive),
      native: true,
    });

    // A binary whose version disagrees with the manifest is rejected.
    const skewed = makeProject({ binaryVersion: "0.0.0-wrong" });
    assembleRelease({ projectRoot: skewed });
    assert.throws(
      () =>
        verifyReleaseArchive({
          archive: join(
            skewed,
            "dist",
            "release",
            TARGETS["linux-x64"].archive,
          ),
          native: true,
        }),
      /instead of/,
    );
  },
);

test(
  "assembly fails closed when a candidate binary is missing",
  posixOnly,
  () => {
    const root = makeProject();
    rmSync(join(root, "dist", TARGETS["linux-x64"].outfile));
    assert.throws(
      () => assembleRelease({ projectRoot: root }),
      /Candidate binary missing/,
    );
  },
);

test(
  "re-assembly rejects a version or input-digest disagreement",
  posixOnly,
  () => {
    const root = makeProject();
    assembleRelease({ projectRoot: root });

    // A rebuilt input (different bytes → different digest) under the already-cut
    // candidate is rejected: assembly never rebuilds an input.
    writeFileSync(
      join(root, "dist", TARGETS["linux-x64"].outfile),
      "#!/bin/sh\n# tampered\nprintf 'x\\n'\n",
    );
    assert.throws(
      () => assembleRelease({ projectRoot: root }),
      /binary digest disagreement/,
    );

    // A changed version under the same candidate manifest is rejected.
    const bumped = makeProject();
    assembleRelease({ projectRoot: bumped });
    writeFileSync(
      join(bumped, "package.json"),
      JSON.stringify(
        { name: "@secantdev/secant", version: "9.9.10-test" },
        null,
        2,
      ),
    );
    assert.throws(
      () => assembleRelease({ projectRoot: bumped }),
      /version disagreement/,
    );
  },
);

test(
  "re-assembly rejects an identity change and a missing archive",
  posixOnly,
  () => {
    // An identity fact edited under the same inputs (here the manifest's recorded
    // executable) is rejected — assertAgrees compares every identity field.
    const root = makeProject();
    assembleRelease({ projectRoot: root });
    const manifestPath = join(root, "dist", "release", MANIFEST_FILE);
    const edited = JSON.parse(readFileSync(manifestPath, "utf8"));
    edited.targets[0].executable = "renamed";
    writeFileSync(manifestPath, JSON.stringify(edited, null, 2));
    assert.throws(
      () => assembleRelease({ projectRoot: root }),
      /identity disagreement/,
    );

    // A candidate whose archive was removed by hand is corrupted, not a no-op.
    const gone = makeProject();
    assembleRelease({ projectRoot: gone });
    rmSync(join(gone, "dist", "release", TARGETS["linux-x64"].archive));
    assert.throws(
      () => assembleRelease({ projectRoot: gone }),
      /missing archive/,
    );
  },
);

test(
  "re-assembly is idempotent when the inputs are unchanged",
  posixOnly,
  () => {
    const root = makeProject();
    const first = assembleRelease({ projectRoot: root });
    const second = assembleRelease({ projectRoot: root });
    assert.deepEqual(second, first);
  },
);

test(
  "the consumer rejects a tampered archive and an unknown archive",
  posixOnly,
  () => {
    const root = makeProject();
    const manifest = assembleRelease({ projectRoot: root });
    const outDir = join(root, "dist", "release");

    const archivePath = join(outDir, TARGETS["linux-x64"].archive);
    appendFileSync(archivePath, "tamper");
    assert.throws(
      () => verifyReleaseArchive({ archive: archivePath, native: false }),
      /does not match the candidate manifest/,
    );

    // An archive name that is not a candidate is refused.
    const stray = join(outDir, "secant-unknown.zip");
    writeFileSync(stray, "not an archive");
    assert.throws(
      () => verifyReleaseArchive({ archive: stray, native: false }),
      /not a candidate archive/,
    );
    assert.ok(manifest.targets.length > 0);

    // The SHA256SUMS cross-check is required, not best-effort.
    const clean = makeProject();
    assembleRelease({ projectRoot: clean });
    const cleanDir = join(clean, "dist", "release");
    rmSync(join(cleanDir, CHECKSUMS_FILE));
    assert.throws(
      () =>
        verifyReleaseArchive({
          archive: join(cleanDir, TARGETS["linux-x64"].archive),
          native: false,
        }),
      new RegExp(`${CHECKSUMS_FILE} is missing`),
    );
  },
);
