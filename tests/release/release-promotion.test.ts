import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  assertProtectedPromotionInvocation,
  loadApprovedCandidate,
  promoteApprovedCandidate,
  createCliPromotionPort,
  PromotionCommandError,
  type ApprovedCandidate,
  type PackagePublication,
  type PromotionPort,
} from "../../scripts/release-promote.js";
import { sha256 } from "../../scripts/assemble.js";
import { launcherPlatforms } from "../../scripts/pack-launcher.js";
import { makeTempDir } from "../helpers/tempDir.js";

const packages: PackagePublication[] = [
  {
    kind: "platform",
    package: "@secantdev/secant-windows-x64",
    version: "1.2.3",
    path: "/candidate/win.tgz",
    sha256: "win-sha",
  },
  {
    kind: "platform",
    package: "@secantdev/secant-darwin-arm64",
    version: "1.2.3",
    path: "/candidate/mac.tgz",
    sha256: "mac-sha",
  },
  {
    kind: "platform",
    package: "@secantdev/secant-linux-x64",
    version: "1.2.3",
    path: "/candidate/linux.tgz",
    sha256: "linux-sha",
  },
  {
    kind: "launcher",
    package: "@secantdev/secant",
    version: "1.2.3",
    path: "/candidate/launcher.tgz",
    sha256: "launcher-sha",
  },
];

const candidate: ApprovedCandidate = {
  tag: "v1.2.3",
  version: "1.2.3",
  packages,
  assets: [
    {
      name: "secant-linux-x64.tar.gz",
      path: "/candidate/secant-linux-x64.tar.gz",
      sha256: "archive-sha",
    },
  ],
};

function fakePromotion(
  states: Record<string, "missing" | "identical" | "conflicting">,
): { port: PromotionPort; events: string[] } {
  const events: string[] = [];
  return {
    events,
    port: {
      inspectPackage(pkg) {
        events.push(`inspect:${pkg.package}`);
        return states[pkg.package] ?? "missing";
      },
      publishPackage(pkg) {
        events.push(`publish:${pkg.package}`);
      },
      exposeGitHubRelease(value) {
        events.push(`github:${value.tag}`);
      },
    },
  };
}

test("release-promotion-state-machine publishes every platform package before the launcher and GitHub assets last", async () => {
  const { port, events } = fakePromotion({});

  await promoteApprovedCandidate(candidate, port);

  assert.deepEqual(events, [
    "inspect:@secantdev/secant-windows-x64",
    "publish:@secantdev/secant-windows-x64",
    "inspect:@secantdev/secant-darwin-arm64",
    "publish:@secantdev/secant-darwin-arm64",
    "inspect:@secantdev/secant-linux-x64",
    "publish:@secantdev/secant-linux-x64",
    "inspect:@secantdev/secant",
    "publish:@secantdev/secant",
    "github:v1.2.3",
  ]);
});

test("release-promotion-state-machine resumes a partial publication and skips identical registry bytes", async () => {
  const { port, events } = fakePromotion({
    "@secantdev/secant-windows-x64": "identical",
    "@secantdev/secant-darwin-arm64": "identical",
  });

  await promoteApprovedCandidate(candidate, port);

  assert.deepEqual(
    events.filter((event) => event.startsWith("publish:")),
    ["publish:@secantdev/secant-linux-x64", "publish:@secantdev/secant"],
  );
  assert.equal(events.at(-1), "github:v1.2.3");
});

test("release-promotion-state-machine makes an identical rerun an idempotent success", async () => {
  const states = Object.fromEntries(
    packages.map((pkg) => [pkg.package, "identical"]),
  ) as Record<string, "identical">;
  const { port, events } = fakePromotion(states);

  await promoteApprovedCandidate(candidate, port);

  assert.equal(
    events.some((event) => event.startsWith("publish:")),
    false,
  );
  assert.equal(events.at(-1), "github:v1.2.3");
});

test("release-promotion-state-machine fails closed on conflicting registry bytes", async () => {
  const { port, events } = fakePromotion({
    "@secantdev/secant-darwin-arm64": "conflicting",
  });

  await assert.rejects(
    promoteApprovedCandidate(candidate, port),
    /Registry conflict.*darwin-arm64/,
  );

  assert.deepEqual(events, [
    "inspect:@secantdev/secant-windows-x64",
    "publish:@secantdev/secant-windows-x64",
    "inspect:@secantdev/secant-darwin-arm64",
  ]);
});

test("release-promotion-state-machine stops before later stages when a platform publish fails", async () => {
  const { port, events } = fakePromotion({});
  port.publishPackage = (pkg) => {
    events.push(`publish:${pkg.package}`);
    if (pkg.package.endsWith("darwin-arm64")) {
      throw new Error("npm unavailable");
    }
  };

  await assert.rejects(
    promoteApprovedCandidate(candidate, port),
    /npm unavailable/,
  );

  assert.equal(
    events.some((event) => event.includes("secant-linux-x64")),
    false,
  );
  assert.equal(
    events.some((event) => event.startsWith("github:")),
    false,
  );
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function approvedCandidateFixture(): {
  releaseDir: string;
  packagesDir: string;
  windowsArchive: string;
  linuxTarball: string;
  launcherTarball: string;
  candidateManifest: string;
  packageManifest: string;
  launcherManifest: string;
  checksums: string;
} {
  const root = makeTempDir("secant-promotion-");
  const releaseDir = join(root, "release");
  const packagesDir = join(root, "packages");
  mkdirSync(releaseDir);
  mkdirSync(packagesDir);

  const targetFacts = [
    [
      "windows-x64",
      "windows",
      "x64",
      "secant-windows-x64.zip",
      "secant.exe",
      "win.tgz",
    ],
    [
      "darwin-arm64",
      "macos",
      "arm64",
      "secant-darwin-arm64.zip",
      "secant",
      "mac.tgz",
    ],
    [
      "linux-x64",
      "linux",
      "x64",
      "secant-linux-x64.tar.gz",
      "secant",
      "linux.tgz",
    ],
  ] as const;
  const targets = targetFacts.map(
    ([key, os, cpu, archive, executable, tarball]) => {
      const archivePath = join(releaseDir, archive);
      writeFileSync(archivePath, `${key}-archive`);
      const tarballPath = join(packagesDir, tarball);
      writeFileSync(tarballPath, `${key}-package`);
      return {
        key,
        os,
        cpu,
        package: `@secantdev/secant-${key}`,
        archive,
        archiveType: archive.endsWith("zip") ? "zip" : "tar.gz",
        executable,
        binarySha256: `${key}-binary-sha`,
        archiveSha256: sha256(archivePath),
        tarball,
        tarballSha256: sha256(tarballPath),
      };
    },
  );
  writeJson(join(releaseDir, "candidate-manifest.json"), {
    version: "1.2.3",
    licenseSha256: "license-sha",
    noticesSha256: "notices-sha",
    targets,
  });
  writeFileSync(
    join(releaseDir, "SHA256SUMS"),
    `${targets.map((target) => `${target.archiveSha256}  ${target.archive}`).join("\n")}\n`,
  );
  writeJson(join(packagesDir, "package-manifest.json"), {
    version: "1.2.3",
    licenseSha256: "license-sha",
    noticesSha256: "notices-sha",
    packages: targets.map((target) => ({
      key: target.key,
      package: target.package,
      os:
        target.os === "windows"
          ? "win32"
          : target.os === "macos"
            ? "darwin"
            : "linux",
      cpu: target.cpu,
      executable: target.executable,
      binarySha256: target.binarySha256,
      tarball: target.tarball,
      tarballSha256: target.tarballSha256,
    })),
  });
  const launcherTarball = join(packagesDir, "launcher.tgz");
  writeFileSync(launcherTarball, "launcher-package");
  writeJson(join(packagesDir, "launcher-manifest.json"), {
    version: "1.2.3",
    package: "@secantdev/secant",
    licenseSha256: "license-sha",
    noticesSha256: "notices-sha",
    platforms: launcherPlatforms(),
    tarball: "launcher.tgz",
    tarballSha256: sha256(launcherTarball),
  });
  return {
    releaseDir,
    packagesDir,
    windowsArchive: join(releaseDir, "secant-windows-x64.zip"),
    linuxTarball: join(packagesDir, "linux.tgz"),
    launcherTarball,
    candidateManifest: join(releaseDir, "candidate-manifest.json"),
    packageManifest: join(packagesDir, "package-manifest.json"),
    launcherManifest: join(packagesDir, "launcher-manifest.json"),
    checksums: join(releaseDir, "SHA256SUMS"),
  };
}

function mutateJson(
  path: string,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(value);
  writeJson(path, value);
}

test("approved candidate loading re-verifies archive and package digests without rebuilding", () => {
  const fixture = approvedCandidateFixture();

  const loaded = loadApprovedCandidate({
    expectedTag: "v1.2.3",
    releaseDir: fixture.releaseDir,
    packagesDir: fixture.packagesDir,
  });

  assert.equal(loaded.version, "1.2.3");
  assert.deepEqual(
    loaded.packages.map((pkg) => pkg.kind),
    ["platform", "platform", "platform", "launcher"],
  );
  assert.deepEqual(
    loaded.assets.map((asset) => asset.name),
    [
      "secant-windows-x64.zip",
      "secant-darwin-arm64.zip",
      "secant-linux-x64.tar.gz",
      "SHA256SUMS",
      "candidate-manifest.json",
    ],
  );
});

test("approved candidate loading fails closed when packed bytes changed after approval", () => {
  const platformFixture = approvedCandidateFixture();
  writeFileSync(platformFixture.linuxTarball, "tampered-package");

  assert.throws(
    () =>
      loadApprovedCandidate({
        expectedTag: "v1.2.3",
        releaseDir: platformFixture.releaseDir,
        packagesDir: platformFixture.packagesDir,
      }),
    /digest disagreement.*linux-x64/,
  );

  const archiveFixture = approvedCandidateFixture();
  writeFileSync(archiveFixture.windowsArchive, "tampered-archive");
  assert.throws(
    () =>
      loadApprovedCandidate({
        expectedTag: "v1.2.3",
        releaseDir: archiveFixture.releaseDir,
        packagesDir: archiveFixture.packagesDir,
      }),
    /digest disagreement.*windows-x64/,
  );

  const launcherFixture = approvedCandidateFixture();
  writeFileSync(launcherFixture.launcherTarball, "tampered-launcher");
  assert.throws(
    () =>
      loadApprovedCandidate({
        expectedTag: "v1.2.3",
        releaseDir: launcherFixture.releaseDir,
        packagesDir: launcherFixture.packagesDir,
      }),
    /digest disagreement.*launcher/,
  );
});

test("approved candidate loading fails closed on tag, checksum, and manifest identity drift", () => {
  const tagFixture = approvedCandidateFixture();
  assert.throws(
    () =>
      loadApprovedCandidate({
        expectedTag: "v9.9.9",
        releaseDir: tagFixture.releaseDir,
        packagesDir: tagFixture.packagesDir,
      }),
    /tag\/version disagreement/,
  );

  const checksumFixture = approvedCandidateFixture();
  writeFileSync(checksumFixture.checksums, "wrong checksums\n");
  assert.throws(
    () =>
      loadApprovedCandidate({
        expectedTag: "v1.2.3",
        releaseDir: checksumFixture.releaseDir,
        packagesDir: checksumFixture.packagesDir,
      }),
    /SHA256SUMS disagrees/,
  );

  const targetFixture = approvedCandidateFixture();
  mutateJson(targetFixture.candidateManifest, (manifest) => {
    const targets = manifest.targets as Record<string, unknown>[];
    targets[0]!.package = "@secantdev/not-approved";
  });
  assert.throws(
    () =>
      loadApprovedCandidate({
        expectedTag: "v1.2.3",
        releaseDir: targetFixture.releaseDir,
        packagesDir: targetFixture.packagesDir,
      }),
    /Package identity disagreement|identity disagreement/,
  );

  const packageFixture = approvedCandidateFixture();
  mutateJson(packageFixture.packageManifest, (manifest) => {
    const packageEntries = manifest.packages as Record<string, unknown>[];
    packageEntries[1]!.binarySha256 = "not-approved";
  });
  assert.throws(
    () =>
      loadApprovedCandidate({
        expectedTag: "v1.2.3",
        releaseDir: packageFixture.releaseDir,
        packagesDir: packageFixture.packagesDir,
      }),
    /binary digest disagreement/,
  );

  const launcherFixture = approvedCandidateFixture();
  mutateJson(launcherFixture.launcherManifest, (manifest) => {
    manifest.package = "@secantdev/not-approved";
  });
  assert.throws(
    () =>
      loadApprovedCandidate({
        expectedTag: "v1.2.3",
        releaseDir: launcherFixture.releaseDir,
        packagesDir: launcherFixture.packagesDir,
      }),
    /launcher manifest disagrees/,
  );
});

test("GitHub exposure stages only approved assets on a draft before making it visible", async () => {
  const root = makeTempDir("secant-github-release-");
  const firstPath = join(root, "first.zip");
  const secondPath = join(root, "SHA256SUMS");
  writeFileSync(firstPath, "first");
  writeFileSync(secondPath, "second");
  const value: ApprovedCandidate = {
    ...candidate,
    assets: [
      { name: "first.zip", path: firstPath, sha256: sha256(firstPath) },
      { name: "SHA256SUMS", path: secondPath, sha256: sha256(secondPath) },
    ],
  };
  const commands: string[] = [];
  const port = createCliPromotionPort((command, args) => {
    commands.push(`${command} ${args.join(" ")}`);
    if (args[1] === "view") {
      return { status: 1, stdout: "", stderr: "release not found" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });

  await port.exposeGitHubRelease(value);

  assert.deepEqual(commands, [
    "gh release view v1.2.3 --json isDraft,assets",
    "gh release create v1.2.3 --draft --verify-tag --title v1.2.3 --notes Secant 1.2.3",
    `gh release upload v1.2.3 ${firstPath}`,
    `gh release upload v1.2.3 ${secondPath}`,
    "gh release edit v1.2.3 --draft=false",
  ]);
});

test("an identical visible GitHub release is an idempotent success", async () => {
  const root = makeTempDir("secant-github-rerun-");
  const assetPath = join(root, "candidate.zip");
  writeFileSync(assetPath, "approved bytes");
  const value: ApprovedCandidate = {
    ...candidate,
    assets: [
      {
        name: "candidate.zip",
        path: assetPath,
        sha256: sha256(assetPath),
      },
    ],
  };
  const commands: string[] = [];
  const port = createCliPromotionPort((command, args) => {
    commands.push(`${command} ${args.join(" ")}`);
    if (args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          isDraft: false,
          assets: [{ name: "candidate.zip" }],
        }),
        stderr: "",
      };
    }
    if (args[1] === "download") {
      const destination = args[args.indexOf("--dir") + 1]!;
      copyFileSync(assetPath, join(destination, "candidate.zip"));
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });

  await port.exposeGitHubRelease(value);

  assert.equal(
    commands.some((command) => command.includes(" upload ")),
    false,
  );
  assert.equal(
    commands.some((command) => command.includes(" edit ")),
    false,
  );
});

test("GitHub exposure fails closed on an unapproved existing asset", () => {
  const port = createCliPromotionPort((_command, args) => {
    if (args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          isDraft: true,
          assets: [{ name: "unapproved.zip" }],
        }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  });

  assert.throws(
    () => port.exposeGitHubRelease(candidate),
    /unapproved asset unapproved\.zip/,
  );
});

test("GitHub exposure resumes an exact partial draft before making it visible", async () => {
  const root = makeTempDir("secant-github-partial-");
  const firstPath = join(root, "first.zip");
  const secondPath = join(root, "second.zip");
  writeFileSync(firstPath, "first approved");
  writeFileSync(secondPath, "second approved");
  const value: ApprovedCandidate = {
    ...candidate,
    assets: [
      { name: "first.zip", path: firstPath, sha256: sha256(firstPath) },
      { name: "second.zip", path: secondPath, sha256: sha256(secondPath) },
    ],
  };
  const commands: string[] = [];
  const port = createCliPromotionPort((command, args) => {
    commands.push(`${command} ${args.join(" ")}`);
    if (args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          isDraft: true,
          assets: [{ name: "first.zip" }],
        }),
        stderr: "",
      };
    }
    if (args[1] === "download") {
      const destination = args[args.indexOf("--dir") + 1]!;
      copyFileSync(firstPath, join(destination, "first.zip"));
    }
    return { status: 0, stdout: "", stderr: "" };
  });

  await port.exposeGitHubRelease(value);

  assert.equal(
    commands.some(
      (command) => command === `gh release upload v1.2.3 ${secondPath}`,
    ),
    true,
  );
  assert.equal(commands.at(-1), "gh release edit v1.2.3 --draft=false");
});

test("GitHub exposure rejects conflicting bytes and a visible partial release", () => {
  const root = makeTempDir("secant-github-conflict-");
  const assetPath = join(root, "candidate.zip");
  writeFileSync(assetPath, "approved");
  const value: ApprovedCandidate = {
    ...candidate,
    assets: [
      {
        name: "candidate.zip",
        path: assetPath,
        sha256: sha256(assetPath),
      },
    ],
  };
  const conflictPort = createCliPromotionPort((_command, args) => {
    if (args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({
          isDraft: true,
          assets: [{ name: "candidate.zip" }],
        }),
        stderr: "",
      };
    }
    if (args[1] === "download") {
      const destination = args[args.indexOf("--dir") + 1]!;
      writeFileSync(join(destination, "candidate.zip"), "conflicting");
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  assert.throws(
    () => conflictPort.exposeGitHubRelease(value),
    /digest disagreement/,
  );

  const visiblePartialPort = createCliPromotionPort(() => ({
    status: 0,
    stdout: JSON.stringify({ isDraft: false, assets: [] }),
    stderr: "",
  }));
  assert.throws(
    () => visiblePartialPort.exposeGitHubRelease(value),
    /refusing to mutate a visible partial release/,
  );
});

test("a failed GitHub asset upload leaves the release in draft", () => {
  const commands: string[] = [];
  const port = createCliPromotionPort((command, args) => {
    commands.push(`${command} ${args.join(" ")}`);
    if (args[1] === "view") {
      return { status: 1, stdout: "", stderr: "release not found" };
    }
    if (args[1] === "upload") {
      return { status: 1, stdout: "", stderr: "upload failed" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });

  assert.throws(
    () => port.exposeGitHubRelease(candidate),
    PromotionCommandError,
  );
  assert.equal(
    commands.some((command) => command.includes(" edit ")),
    false,
  );
});

test("registry inspection accepts an existing version only when downloaded bytes match", async () => {
  const root = makeTempDir("secant-registry-rerun-");
  const tarball = join(root, "candidate.tgz");
  writeFileSync(tarball, "approved package bytes");
  const pkg: PackagePublication = {
    kind: "platform",
    package: "@secantdev/secant-linux-x64",
    version: "1.2.3",
    path: tarball,
    sha256: sha256(tarball),
  };
  const inspect = (downloaded: string) =>
    createCliPromotionPort((_command, args) => {
      if (args[0] === "view") {
        return { status: 0, stdout: '"1.2.3"', stderr: "" };
      }
      const destination = args[args.indexOf("--pack-destination") + 1]!;
      writeFileSync(join(destination, "registry.tgz"), downloaded);
      return {
        status: 0,
        stdout: JSON.stringify([{ filename: "registry.tgz" }]),
        stderr: "",
      };
    }).inspectPackage(pkg);

  assert.equal(await inspect("approved package bytes"), "identical");
  assert.equal(await inspect("different package bytes"), "conflicting");
});

test("registry inspection treats only npm not-found as a missing version", async () => {
  const missingPort = createCliPromotionPort(() => ({
    status: 1,
    stdout: "",
    stderr: "npm error code E404",
  }));
  assert.equal(await missingPort.inspectPackage(packages[0]!), "missing");

  const unavailablePort = createCliPromotionPort(() => ({
    status: 1,
    stdout: "",
    stderr: "network timeout",
  }));
  await assert.rejects(
    async () => unavailablePort.inspectPackage(packages[0]!),
    (error: unknown) =>
      error instanceof PromotionCommandError &&
      error.stderr === "network timeout" &&
      error.command === "npm",
  );
});

test("promotion has no supported developer-machine or validation-mode entrypoint", () => {
  assert.throws(
    () => assertProtectedPromotionInvocation({}),
    /only by the tag-triggered protected GitHub Actions job/,
  );
  assert.throws(
    () =>
      assertProtectedPromotionInvocation({
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_NAME: "main",
        NODE_AUTH_TOKEN: "token",
        GH_TOKEN: "token",
      }),
    /only by the tag-triggered protected GitHub Actions job/,
  );
  assert.equal(
    assertProtectedPromotionInvocation({
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/tags/v1.2.3",
      GITHUB_REF_NAME: "v1.2.3",
      NODE_AUTH_TOKEN: "token",
      GH_TOKEN: "token",
    }),
    "v1.2.3",
  );
});
