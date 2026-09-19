import assert from "node:assert/strict";
import test from "node:test";
import {
  nativePackageFor,
  verifyChannelLegalDigests,
  verifyClosureNotices,
  type ClosureComponent,
  packageDirOfSource,
} from "../../scripts/inventory.js";
import { TARGETS } from "../../scripts/targets.js";

// Pure legal-closure logic only; spawns NO subprocess and runs no build. The real
// closure derivation (a Bun.build) and the whole gate run as the final step of the
// Linux `build` job (docs/agents/release-consumers.md), the one place that has
// cross-compiled every target and installed every platform's native.

const UNION: ClosureComponent[] = [
  { name: "commander", version: "14.0.2", license: "MIT" },
  { name: "semver", version: "7.7.4", license: "ISC" },
  { name: "drizzle-orm", version: "1.0.0-rc.4", license: "Apache-2.0" },
  { name: "entities", version: "7.0.1", license: "BSD-2-Clause" },
  { name: "fast-uri", version: "3.1.8", license: "BSD-3-Clause" },
  { name: "isexe", version: "4.0.0", license: "BlueOak-1.0.0" },
];

/** A notices string that covers every component and licence family in UNION. */
const COVERING_NOTICES = [
  "`commander` `14.0.2`",
  "`semver` `7.7.4`",
  "`drizzle-orm` `1.0.0-rc.4`",
  "`entities` `7.0.1`",
  "`fast-uri` `3.1.8`",
  "`isexe` `4.0.0`",
  "MIT License",
  "The ISC License",
  "Apache License",
  "BSD 2-Clause",
  "BSD 3-Clause",
  "Blue Oak Model License",
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
  const noBlueOak = COVERING_NOTICES.replace("Blue Oak Model License", "");
  const problems = verifyClosureNotices(UNION, noBlueOak);
  assert.ok(problems.some((p) => /No BlueOak-1\.0\.0 licence text/.test(p)));
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

const TRUTH = { licenseSha256: "aaa", noticesSha256: "bbb" };

test("verifyChannelLegalDigests passes when every channel ships the source of truth", () => {
  const channels = ["Release archives", "Platform packages", "Launcher"].map(
    (label) => ({ label, ...TRUTH }),
  );
  assert.deepEqual(verifyChannelLegalDigests(channels, TRUTH), []);
});

test("verifyChannelLegalDigests fails a channel with drifted legal material", () => {
  const channels = [
    { label: "Release archives", ...TRUTH },
    {
      label: "Platform packages",
      licenseSha256: "aaa",
      noticesSha256: "wrong",
    },
  ];
  const problems = verifyChannelLegalDigests(channels, TRUTH);
  assert.equal(problems.length, 1);
  assert.ok(/Platform packages.*THIRD-PARTY-NOTICES/.test(problems[0]));
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
