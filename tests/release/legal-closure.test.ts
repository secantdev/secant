import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { LICENSE_FILE, NOTICES_FILE, sha256 } from "../../scripts/assemble.js";
import {
  nativePackageFor,
  packageDirOfSource,
  type ClosureComponent,
} from "../../scripts/inventory.js";
import {
  verifyClosureNotices,
  verifyStagedLegal,
  type SourceOfTruth,
} from "../../scripts/release-legal-closure-consumer.js";
import { TARGETS } from "../../scripts/targets.js";
import { makeTempDir } from "../helpers/tempDir.js";

// Pure legal-closure logic only; spawns NO subprocess. The archive/tarball
// extraction round-trip on real channel artifacts is proven end to end by the
// three-OS `release-legal-closure` CI job (docs/agents/release-consumers.md),
// deliberately kept out of `bun test` for the Bun 1.4.2 child-lifecycle reason
// (#149), as the sibling consumers are.

const UNION: ClosureComponent[] = [
  { name: "commander", version: "14.0.2", license: "MIT" },
  { name: "semver", version: "7.7.4", license: "ISC" },
  { name: "drizzle-orm", version: "1.0.0-rc.4", license: "Apache-2.0" },
  { name: "entities", version: "7.0.1", license: "BSD-2-Clause" },
  { name: "fast-uri", version: "3.1.8", license: "BSD-3-Clause" },
];

/** A notices string that covers every component and licence family in UNION. */
const COVERING_NOTICES = [
  "`commander` `14.0.2`",
  "`semver` `7.7.4`",
  "`drizzle-orm` `1.0.0-rc.4`",
  "`entities` `7.0.1`",
  "`fast-uri` `3.1.8`",
  "MIT License",
  "The ISC License",
  "Apache License",
  "BSD 2-Clause",
  "BSD 3-Clause",
].join("\n");

test("verifyClosureNotices passes when every component and licence family is covered", () => {
  assert.deepEqual(verifyClosureNotices(UNION, COVERING_NOTICES), []);
});

test("verifyClosureNotices tolerates an extra historical notice not in the closure", () => {
  const withExtra = `${COVERING_NOTICES}\n\`bun-ffi-structs\` \`0.2.4\``;
  assert.deepEqual(verifyClosureNotices(UNION, withExtra), []);
});

test("verifyClosureNotices fails a shipped component with no section", () => {
  const missing = COVERING_NOTICES.replace("`entities` `7.0.1`", "");
  const problems = verifyClosureNotices(UNION, missing);
  assert.ok(problems.some((p) => /entities.*no notices section/.test(p)));
});

test("verifyClosureNotices fails a stale shipped version", () => {
  const stale = COVERING_NOTICES.replace(
    "`semver` `7.7.4`",
    "`semver` `7.7.0`",
  );
  const problems = verifyClosureNotices(UNION, stale);
  assert.ok(problems.some((p) => /semver.*shipped version `7.7.4`/.test(p)));
});

test("verifyClosureNotices fails when a shipped licence family's text is absent", () => {
  const noBsd3 = COVERING_NOTICES.replace("BSD 3-Clause", "");
  const problems = verifyClosureNotices(UNION, noBsd3);
  assert.ok(problems.some((p) => /No BSD-3-Clause licence text/.test(p)));
});

test("verifyClosureNotices fails closed on an unrecognised licence identity", () => {
  const union = [
    ...UNION,
    { name: "spooky", version: "1.0.0", license: "GPL-3.0" },
  ];
  const notices = `${COVERING_NOTICES}\n\`spooky\` \`1.0.0\``;
  const problems = verifyClosureNotices(union, notices);
  assert.ok(
    problems.some((p) => /GPL-3\.0.*not a recognised licence family/.test(p)),
  );
});

/** Stage a channel's legal material as a consumer receives it. */
function stageLegal(
  license = "L",
  notices = "N",
): {
  dir: string;
  truth: SourceOfTruth;
} {
  const dir = makeTempDir("secant-legal-staged-");
  writeFileSync(join(dir, LICENSE_FILE), license);
  writeFileSync(join(dir, NOTICES_FILE), notices);
  return {
    dir,
    truth: {
      licenseSha256: sha256(join(dir, LICENSE_FILE)),
      noticesSha256: sha256(join(dir, NOTICES_FILE)),
    },
  };
}

test("verifyStagedLegal accepts channel material identical to the source of truth", () => {
  const { dir, truth } = stageLegal();
  assert.deepEqual(verifyStagedLegal("chan", dir, truth), []);
});

test("verifyStagedLegal fails on absent legal material", () => {
  const { dir, truth } = stageLegal();
  rmSync(join(dir, NOTICES_FILE));
  const problems = verifyStagedLegal("chan", dir, truth);
  assert.ok(
    problems.some((p) => new RegExp(`missing ${NOTICES_FILE}`).test(p)),
  );
});

test("verifyStagedLegal fails on tampered legal bytes", () => {
  const { dir, truth } = stageLegal();
  writeFileSync(join(dir, LICENSE_FILE), "tampered");
  const problems = verifyStagedLegal("chan", dir, truth);
  assert.ok(
    problems.some((p) => new RegExp(`unexpected ${LICENSE_FILE}`).test(p)),
  );
});

test("packageDirOfSource resolves the deepest node_modules segment", () => {
  assert.equal(
    packageDirOfSource("node_modules/semver/classes/semver.js"),
    "node_modules/semver",
  );
  assert.equal(
    packageDirOfSource("node_modules/@opentui/core/index.js"),
    "node_modules/@opentui/core",
  );
  // A nested duplicate resolves to its own package, not a hoisted sibling.
  assert.equal(
    packageDirOfSource(
      "node_modules/@modelcontextprotocol/sdk/node_modules/ajv/dist/core.js",
    ),
    "node_modules/@modelcontextprotocol/sdk/node_modules/ajv",
  );
  // First-party sources are not packages.
  assert.equal(packageDirOfSource("src/cli/main.ts"), undefined);
});

test("nativePackageFor maps each target to its embedded @opentui native", () => {
  assert.equal(
    nativePackageFor(TARGETS["windows-x64"]),
    "@opentui/core-win32-x64",
  );
  assert.equal(
    nativePackageFor(TARGETS["darwin-arm64"]),
    "@opentui/core-darwin-arm64",
  );
  assert.equal(
    nativePackageFor(TARGETS["linux-x64"]),
    "@opentui/core-linux-x64",
  );
});
