import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateManifest } from "../../scripts/assemble.js";
import { LOCK_FILE } from "../../scripts/shipped-bundles.js";
import {
  formatApprovalSummary,
  parseShippedBundleLock,
  parseTagVersion,
  SHIPPED_BUNDLE_LOCK,
  tagMatchesVersion,
  terminalInputs,
  windowsTerminalTrigger,
} from "../../scripts/release-gate.js";

test("parseTagVersion accepts only a v* release tag ref", () => {
  assert.equal(parseTagVersion("refs/tags/v1.2.3"), "1.2.3");
  assert.equal(parseTagVersion("refs/tags/v0.1.0"), "0.1.0");
  assert.equal(parseTagVersion("refs/heads/main"), null);
  assert.equal(parseTagVersion("refs/tags/nightly"), null);
  assert.equal(parseTagVersion(""), null);
});

test("a tag authorizes promotion only when it exactly matches the package version", () => {
  assert.ok(tagMatchesVersion("refs/tags/v1.2.3", "1.2.3").ok);
  assert.equal(tagMatchesVersion("refs/tags/v1.2.3", "1.2.4").ok, false);
  assert.equal(tagMatchesVersion("refs/heads/main", "1.2.3").ok, false);
  // A prefix/suffix mismatch is not a match (no substring escape hatch).
  assert.equal(tagMatchesVersion("refs/tags/v1.2.30", "1.2.3").ok, false);
});

test("terminalInputs reads the Bun and OpenTUI pins, tolerating absence", () => {
  assert.deepEqual(
    terminalInputs({
      packageManager: "bun@1.4.2",
      dependencies: { "@opentui/core": "0.4.5" },
    }),
    { bunPin: "bun@1.4.2", openTuiPin: "0.4.5" },
  );
  assert.deepEqual(terminalInputs({}), { bunPin: "", openTuiPin: "" });
  assert.deepEqual(terminalInputs(null), { bunPin: "", openTuiPin: "" });
});

test("the first release always requires fresh Windows Terminal evidence", () => {
  const trigger = windowsTerminalTrigger(
    null,
    null,
    { bunPin: "bun@1.4.2", openTuiPin: "0.4.5" },
    false,
  );
  assert.ok(trigger.fresh);
  assert.match(trigger.reason, /First release/);
});

test("an unreadable previous tag fails safe with an honest reason, not 'first release'", () => {
  const trigger = windowsTerminalTrigger(
    "v1.0.0",
    null,
    { bunPin: "bun@1.4.2", openTuiPin: "0.4.5" },
    false,
  );
  assert.ok(trigger.fresh);
  assert.match(trigger.reason, /Could not read the previous tag \(v1\.0\.0\)/);
  assert.doesNotMatch(trigger.reason, /First release/);
});

test("unchanged terminal inputs carry the prior report forward", () => {
  const same = { bunPin: "bun@1.4.2", openTuiPin: "0.4.5" };
  const trigger = windowsTerminalTrigger("v1.0.0", same, same, false);
  assert.equal(trigger.fresh, false);
  assert.match(trigger.reason, /carried forward from v1\.0\.0/);
});

test("each triggering input independently re-arms the fresh evidence requirement", () => {
  const base = { bunPin: "bun@1.4.2", openTuiPin: "0.4.5" };
  assert.ok(
    windowsTerminalTrigger(
      "v1.0.0",
      base,
      { ...base, bunPin: "bun@1.5.0" },
      false,
    ).fresh,
  );
  assert.ok(
    windowsTerminalTrigger(
      "v1.0.0",
      base,
      { ...base, openTuiPin: "0.5.0" },
      false,
    ).fresh,
  );
  const rendererOnly = windowsTerminalTrigger("v1.0.0", base, base, true);
  assert.ok(rendererOnly.fresh);
  assert.match(rendererOnly.reason, /src\/tui\/renderer/);
});

const manifest: CandidateManifest = {
  version: "1.2.3",
  licenseSha256: "a".repeat(64),
  noticesSha256: "b".repeat(64),
  targets: [
    {
      key: "linux-x64",
      os: "linux",
      cpu: "x64",
      package: "@secantdev/secant-linux-x64",
      archive: "secant-linux-x64.tar.gz",
      archiveType: "tar.gz",
      executable: "secant",
      binarySha256: "c".repeat(64),
      archiveSha256: "d".repeat(64),
    },
  ],
};

test("the approval summary exposes every field the reviewer approves", () => {
  const summary = formatApprovalSummary({
    tag: "v1.2.3",
    commit: "deadbeef",
    version: "1.2.3",
    manifest,
    shippedBundles: [
      { id: "dev.secant.matt-front", version: "2.6.0", digest: "e".repeat(64) },
    ],
    terminalTrigger: { fresh: false, reason: "carried forward from v1.0.0" },
  });
  for (const needle of [
    "v1.2.3", // tag
    "deadbeef", // commit
    "1.2.3", // version
    "c".repeat(64), // binary digest
    "d".repeat(64), // archive digest
    `dev.secant.matt-front@2.6.0: \`${"e".repeat(64)}\``, // Shipped Bundle identity and digest
    "docs/release-checklist.md", // checklist reference
    "Blocking jobs", // dependency evidence
    "Windows Terminal evidence: carried forward", // WT trigger decision
  ]) {
    assert.ok(summary.includes(needle), `summary missing: ${needle}`);
  }
});

test("the gate reads the same lock file the build checks the embedded bytes against", () => {
  assert.equal(SHIPPED_BUNDLE_LOCK, LOCK_FILE);
});

test("a malformed Shipped Bundle lock fails the gate instead of printing a hole", () => {
  const entry = {
    id: "dev.secant.matt-front",
    version: "2.6.0",
    digest: "e".repeat(64),
  };
  assert.deepEqual(parseShippedBundleLock([entry]), [entry]);
  for (const bad of [
    {},
    [{ ...entry, digest: undefined }],
    [{ ...entry, digest: "not-a-sha" }],
    [{ ...entry, id: 1 }],
    [{ id: entry.id, version: entry.version, sha256: entry.digest }],
  ]) {
    assert.throws(
      () => parseShippedBundleLock(bad),
      /bundles\/builtin\.lock\.json/,
    );
  }
});
