#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  CHECKSUMS_FILE,
  MANIFEST_FILE,
  assertAgrees,
  sha256,
  type CandidateManifest,
} from "./assemble.js";
import { LAUNCHER_MANIFEST_FILE, launcherPlatforms } from "./pack-launcher.js";
import {
  NPM_OS,
  PACKAGE_MANIFEST_FILE,
  assertPackagesAgree,
  type PackageManifest,
} from "./pack.js";
import { TARGETS } from "./targets.js";

export type PublishedPackageState = "missing" | "identical" | "conflicting";

export interface PackagePublication {
  readonly kind: "platform" | "launcher";
  readonly package: string;
  readonly version: string;
  readonly path: string;
  readonly sha256: string;
}

export interface ReleaseAsset {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
}

export interface ApprovedCandidate {
  readonly tag: string;
  readonly version: string;
  readonly packages: readonly PackagePublication[];
  readonly assets: readonly ReleaseAsset[];
}

export interface PromotionPort {
  inspectPackage(
    pkg: PackagePublication,
  ): Promise<PublishedPackageState> | PublishedPackageState;
  publishPackage(pkg: PackagePublication): Promise<void> | void;
  exposeGitHubRelease(candidate: ApprovedCandidate): Promise<void> | void;
}

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

type RunCommand = (command: string, args: readonly string[]) => CommandResult;

export class PromotionCommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;

  constructor(options: {
    command: string;
    args: readonly string[];
    status: number;
    stdout: string;
    stderr: string;
    cause?: unknown;
  }) {
    const detail =
      options.stderr.trim() || options.stdout.trim() || "no output";
    super(
      `${options.command} ${options.args.join(" ")} failed (status ${options.status}): ${detail}`,
      { cause: options.cause },
    );
    this.name = "PromotionCommandError";
    this.command = options.command;
    this.args = options.args;
    this.status = options.status;
    this.stderr = options.stderr;
    this.stdout = options.stdout;
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid approved candidate field: ${field}.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid approved candidate field: ${field}.`);
  }
  return value;
}

function entries(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid approved candidate field: ${field}.`);
  }
  return value.map((entry, index) => record(entry, `${field}[${index}]`));
}

function readManifest(path: string, field: string): Record<string, unknown> {
  if (!existsSync(path)) throw new Error(`Approved ${field} missing: ${path}.`);
  try {
    return record(JSON.parse(readFileSync(path, "utf8")), field);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Approved ${field} is not valid JSON: ${path}.`, {
        cause: error,
      });
    }
    throw error;
  }
}

function candidateFilename(value: unknown, field: string): string {
  const name = text(value, field);
  if (basename(name) !== name || name === "." || name === "..") {
    throw new Error(`Invalid approved candidate filename: ${field}.`);
  }
  return name;
}

function assertDigest(path: string, expected: string, subject: string): void {
  if (!existsSync(path))
    throw new Error(`Approved ${subject} missing: ${path}.`);
  const actual = sha256(path);
  if (actual !== expected) {
    throw new Error(
      `Approved candidate digest disagreement for ${subject}: expected ${expected}, got ${actual}.`,
    );
  }
}

function validateCandidateManifest(
  value: Record<string, unknown>,
  releaseDir: string,
): CandidateManifest {
  const version = text(value.version, "candidate-manifest.version");
  const licenseSha256 = text(
    value.licenseSha256,
    "candidate-manifest.licenseSha256",
  );
  const noticesSha256 = text(
    value.noticesSha256,
    "candidate-manifest.noticesSha256",
  );
  const targetValues = entries(value.targets, "candidate-manifest.targets");
  const targetKeys = Object.keys(TARGETS);
  if (targetValues.length !== targetKeys.length) {
    throw new Error(
      "Approved candidate target-set disagreement with the release target manifest.",
    );
  }
  const targets = targetValues.map((entry, index) => {
    const key = text(entry.key, `candidate-manifest.targets[${index}].key`);
    const expected = TARGETS[key];
    if (expected === undefined || key !== targetKeys[index]) {
      throw new Error(
        `Approved candidate target-set disagreement at ${key}; targets must match the release target manifest in order.`,
      );
    }
    const archive = candidateFilename(
      entry.archive,
      `candidate-manifest.targets[${index}].archive`,
    );
    const archiveSha256 = text(
      entry.archiveSha256,
      `candidate-manifest.targets[${index}].archiveSha256`,
    );
    const archiveType = text(
      entry.archiveType,
      `candidate-manifest.targets[${index}].archiveType`,
    );
    if (archiveType !== "zip" && archiveType !== "tar.gz") {
      throw new Error(
        `Invalid approved candidate field: candidate-manifest.targets[${index}].archiveType.`,
      );
    }
    const identity = {
      os: text(entry.os, `candidate-manifest.targets[${index}].os`),
      cpu: text(entry.cpu, `candidate-manifest.targets[${index}].cpu`),
      package: text(
        entry.package,
        `candidate-manifest.targets[${index}].package`,
      ),
      archive,
      executable: text(
        entry.executable,
        `candidate-manifest.targets[${index}].executable`,
      ),
    };
    assertDigest(join(releaseDir, archive), archiveSha256, key);
    const target: CandidateManifest["targets"][number] = {
      key,
      ...identity,
      archiveType,
      binarySha256: text(
        entry.binarySha256,
        `candidate-manifest.targets[${index}].binarySha256`,
      ),
      archiveSha256,
    };
    return target;
  });
  const manifest: CandidateManifest = {
    version,
    licenseSha256,
    noticesSha256,
    targets,
  };
  assertAgrees(manifest, {
    version,
    licenseSha256,
    noticesSha256,
    targets: targetKeys.map((key, index) => {
      const target = TARGETS[key];
      return {
        key,
        os: target.os,
        cpu: target.cpu,
        package: target.package,
        archive: target.archive,
        archiveType: target.archiveType,
        executable: target.executable,
        binarySha256: targets[index]!.binarySha256,
        archiveSha256: targets[index]!.archiveSha256,
      };
    }),
  });
  return manifest;
}

function validateChecksums(
  candidate: CandidateManifest,
  releaseDir: string,
): void {
  const path = join(releaseDir, CHECKSUMS_FILE);
  if (!existsSync(path))
    throw new Error(`Approved checksums missing: ${path}.`);
  const expected = `${candidate.targets
    .map((target) => `${target.archiveSha256}  ${target.archive}`)
    .join("\n")}\n`;
  if (readFileSync(path, "utf8") !== expected) {
    throw new Error(
      "Approved SHA256SUMS disagrees with the candidate manifest.",
    );
  }
}

function validatePackageManifest(
  value: Record<string, unknown>,
  candidate: CandidateManifest,
  packagesDir: string,
): PackagePublication[] {
  const version = text(value.version, "package-manifest.version");
  const licenseSha256 = text(
    value.licenseSha256,
    "package-manifest.licenseSha256",
  );
  const noticesSha256 = text(
    value.noticesSha256,
    "package-manifest.noticesSha256",
  );
  if (
    version !== candidate.version ||
    licenseSha256 !== candidate.licenseSha256 ||
    noticesSha256 !== candidate.noticesSha256
  ) {
    throw new Error(
      "Approved platform-package manifest disagrees with the archive candidate.",
    );
  }
  const packageValues = entries(value.packages, "package-manifest.packages");
  if (packageValues.length !== candidate.targets.length) {
    throw new Error(
      "Approved platform-package target-set disagreement with the archive candidate.",
    );
  }
  const packages = packageValues.map((entry, index) => {
    const target = candidate.targets[index]!;
    const key = text(entry.key, `package-manifest.packages[${index}].key`);
    if (key !== target.key) {
      throw new Error(
        `Approved platform-package order disagreement at ${key}; packages must follow the candidate target order.`,
      );
    }
    const tarball = candidateFilename(
      entry.tarball,
      `package-manifest.packages[${index}].tarball`,
    );
    const tarballSha256 = text(
      entry.tarballSha256,
      `package-manifest.packages[${index}].tarballSha256`,
    );
    assertDigest(join(packagesDir, tarball), tarballSha256, target.key);
    return {
      key,
      package: text(
        entry.package,
        `package-manifest.packages[${index}].package`,
      ),
      os: text(entry.os, `package-manifest.packages[${index}].os`),
      cpu: text(entry.cpu, `package-manifest.packages[${index}].cpu`),
      executable: text(
        entry.executable,
        `package-manifest.packages[${index}].executable`,
      ),
      binarySha256: text(
        entry.binarySha256,
        `package-manifest.packages[${index}].binarySha256`,
      ),
      tarball,
      tarballSha256,
    };
  });
  const manifest: PackageManifest = {
    version,
    licenseSha256,
    noticesSha256,
    packages,
  };
  assertPackagesAgree(manifest, {
    version: candidate.version,
    licenseSha256: candidate.licenseSha256,
    noticesSha256: candidate.noticesSha256,
    packages: candidate.targets.map((target) => ({
      key: target.key,
      package: target.package,
      os: NPM_OS[TARGETS[target.key].os],
      cpu: target.cpu,
      executable: target.executable,
      binarySha256: target.binarySha256,
      tarball: "",
      tarballSha256: "",
    })),
  });
  return packages.map((pkg) => ({
    kind: "platform",
    package: pkg.package,
    version,
    path: join(packagesDir, pkg.tarball),
    sha256: pkg.tarballSha256,
  }));
}

function validateLauncherManifest(
  value: Record<string, unknown>,
  candidate: CandidateManifest,
  packagesDir: string,
): PackagePublication {
  const version = text(value.version, "launcher-manifest.version");
  const packageName = text(value.package, "launcher-manifest.package");
  const licenseSha256 = text(
    value.licenseSha256,
    "launcher-manifest.licenseSha256",
  );
  const noticesSha256 = text(
    value.noticesSha256,
    "launcher-manifest.noticesSha256",
  );
  const platforms = record(value.platforms, "launcher-manifest.platforms");
  const tarball = candidateFilename(value.tarball, "launcher-manifest.tarball");
  const tarballSha256 = text(
    value.tarballSha256,
    "launcher-manifest.tarballSha256",
  );
  if (
    version !== candidate.version ||
    packageName !== "@secantdev/secant" ||
    licenseSha256 !== candidate.licenseSha256 ||
    noticesSha256 !== candidate.noticesSha256
  ) {
    throw new Error(
      "Approved launcher manifest disagrees with the archive candidate.",
    );
  }
  if (JSON.stringify(platforms) !== JSON.stringify(launcherPlatforms())) {
    throw new Error(
      "Approved launcher platform identity disagrees with the release target manifest.",
    );
  }
  assertDigest(join(packagesDir, tarball), tarballSha256, "launcher");
  return {
    kind: "launcher",
    package: packageName,
    version,
    path: join(packagesDir, tarball),
    sha256: tarballSha256,
  };
}

export function loadApprovedCandidate(options: {
  readonly expectedTag: string;
  readonly releaseDir: string;
  readonly packagesDir: string;
}): ApprovedCandidate {
  const candidatePath = join(options.releaseDir, MANIFEST_FILE);
  const candidate = validateCandidateManifest(
    readManifest(candidatePath, "candidate manifest"),
    options.releaseDir,
  );
  if (options.expectedTag !== `v${candidate.version}`) {
    throw new Error(
      `Approved tag/version disagreement: ${options.expectedTag} does not equal v${candidate.version}.`,
    );
  }
  validateChecksums(candidate, options.releaseDir);
  const platformPackages = validatePackageManifest(
    readManifest(
      join(options.packagesDir, PACKAGE_MANIFEST_FILE),
      "package manifest",
    ),
    candidate,
    options.packagesDir,
  );
  const launcher = validateLauncherManifest(
    readManifest(
      join(options.packagesDir, LAUNCHER_MANIFEST_FILE),
      "launcher manifest",
    ),
    candidate,
    options.packagesDir,
  );
  const assetNames = [
    ...candidate.targets.map((target) => target.archive),
    CHECKSUMS_FILE,
    MANIFEST_FILE,
  ];
  return {
    tag: options.expectedTag,
    version: candidate.version,
    packages: [...platformPackages, launcher],
    assets: assetNames.map((name) => {
      const path = join(options.releaseDir, name);
      return { name, path, sha256: sha256(path) };
    }),
  };
}

/** Publish the already-verified candidate in dependency order. A failure or byte
 * conflict stops the state machine before the launcher and GitHub release. */
export async function promoteApprovedCandidate(
  candidate: ApprovedCandidate,
  port: PromotionPort,
): Promise<void> {
  const platformPackages = candidate.packages.filter(
    (pkg) => pkg.kind === "platform",
  );
  const launchers = candidate.packages.filter((pkg) => pkg.kind === "launcher");
  if (platformPackages.length === 0 || launchers.length !== 1) {
    throw new Error(
      "The approved candidate must contain platform packages and exactly one launcher.",
    );
  }

  for (const pkg of [...platformPackages, launchers[0]!]) {
    const state = await port.inspectPackage(pkg);
    if (state === "conflicting") {
      throw new Error(
        `Registry conflict for ${pkg.package}@${pkg.version}: published bytes differ from the approved candidate.`,
      );
    }
    if (state === "missing") await port.publishPackage(pkg);
  }

  await port.exposeGitHubRelease(candidate);
}

function commandFailure(
  command: string,
  args: readonly string[],
  result: CommandResult,
): PromotionCommandError {
  return new PromotionCommandError({
    command,
    args,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function runChecked(
  run: RunCommand,
  command: string,
  args: readonly string[],
): CommandResult {
  const result = run(command, args);
  if (result.status !== 0) throw commandFailure(command, args, result);
  return result;
}

function jsonRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${subject} response.`);
  }
  return value as Record<string, unknown>;
}

function inspectPublishedPackage(
  run: RunCommand,
  pkg: PackagePublication,
): PublishedPackageState {
  const spec = `${pkg.package}@${pkg.version}`;
  const viewArgs = ["view", spec, "version", "--json"];
  const view = run("npm", viewArgs);
  if (view.status !== 0) {
    if (/\bE404\b|404 Not Found|is not in this registry/i.test(view.stderr)) {
      return "missing";
    }
    throw commandFailure("npm", viewArgs, view);
  }

  const downloadDir = mkdtempSync(join(tmpdir(), "secant-registry-package-"));
  try {
    const packArgs = [
      "pack",
      spec,
      "--pack-destination",
      downloadDir,
      "--json",
    ];
    const packed = runChecked(run, "npm", packArgs);
    let response: unknown;
    try {
      response = JSON.parse(packed.stdout);
    } catch (error) {
      throw new Error(`npm pack returned invalid JSON for ${spec}.`, {
        cause: error,
      });
    }
    if (!Array.isArray(response) || response.length !== 1) {
      throw new Error(`npm pack returned an invalid result for ${spec}.`);
    }
    const result = jsonRecord(response[0], `npm pack ${spec}`);
    const filename = candidateFilename(result.filename, `npm pack ${spec}`);
    const downloadedPath = join(downloadDir, filename);
    if (!existsSync(downloadedPath)) {
      throw new Error(`npm pack did not write ${downloadedPath}.`);
    }
    return sha256(downloadedPath) === pkg.sha256 ? "identical" : "conflicting";
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

function publishedRelease(
  run: RunCommand,
  tag: string,
):
  | { readonly isDraft: boolean; readonly assets: readonly string[] }
  | undefined {
  const args = ["release", "view", tag, "--json", "isDraft,assets"];
  const result = run("gh", args);
  if (result.status !== 0) {
    if (/release not found|HTTP 404/i.test(result.stderr)) return undefined;
    throw commandFailure("gh", args, result);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh release view returned invalid JSON for ${tag}.`, {
      cause: error,
    });
  }
  const release = jsonRecord(value, `GitHub release ${tag}`);
  if (typeof release.isDraft !== "boolean" || !Array.isArray(release.assets)) {
    throw new Error(`Invalid GitHub release response for ${tag}.`);
  }
  const assets = release.assets.map((asset, index) =>
    text(
      jsonRecord(asset, `GitHub release asset ${index}`).name,
      `asset ${index}`,
    ),
  );
  if (new Set(assets).size !== assets.length) {
    throw new Error(`GitHub release ${tag} contains duplicate asset names.`);
  }
  return { isDraft: release.isDraft, assets };
}

function assertExistingAsset(
  run: RunCommand,
  tag: string,
  asset: ReleaseAsset,
): void {
  const downloadDir = mkdtempSync(join(tmpdir(), "secant-release-asset-"));
  try {
    runChecked(run, "gh", [
      "release",
      "download",
      tag,
      "--pattern",
      asset.name,
      "--dir",
      downloadDir,
    ]);
    assertDigest(join(downloadDir, asset.name), asset.sha256, asset.name);
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

function exposeGitHubRelease(
  run: RunCommand,
  candidate: ApprovedCandidate,
): void {
  let release = publishedRelease(run, candidate.tag);
  if (release === undefined) {
    runChecked(run, "gh", [
      "release",
      "create",
      candidate.tag,
      "--draft",
      "--verify-tag",
      "--title",
      candidate.tag,
      "--notes",
      `Secant ${candidate.version}`,
    ]);
    release = { isDraft: true, assets: [] };
  }

  const approvedByName = new Map(
    candidate.assets.map((asset) => [asset.name, asset]),
  );
  for (const name of release.assets) {
    const approved = approvedByName.get(name);
    if (approved === undefined) {
      throw new Error(
        `GitHub release ${candidate.tag} contains unapproved asset ${name}.`,
      );
    }
    assertExistingAsset(run, candidate.tag, approved);
  }

  const existing = new Set(release.assets);
  const missing = candidate.assets.filter((asset) => !existing.has(asset.name));
  if (!release.isDraft && missing.length > 0) {
    throw new Error(
      `Published GitHub release ${candidate.tag} is missing approved assets; refusing to mutate a visible partial release.`,
    );
  }
  for (const asset of missing) {
    runChecked(run, "gh", ["release", "upload", candidate.tag, asset.path]);
  }
  if (release.isDraft) {
    runChecked(run, "gh", ["release", "edit", candidate.tag, "--draft=false"]);
  }
}

export function createCliPromotionPort(run: RunCommand): PromotionPort {
  return {
    inspectPackage(pkg) {
      return inspectPublishedPackage(run, pkg);
    },
    publishPackage(pkg) {
      runChecked(run, "npm", ["publish", pkg.path, "--access", "public"]);
    },
    exposeGitHubRelease(candidate) {
      exposeGitHubRelease(run, candidate);
    },
  };
}

export function assertProtectedPromotionInvocation(
  environment: NodeJS.ProcessEnv,
): string {
  const tag = environment.GITHUB_REF_NAME;
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    !tag ||
    environment.GITHUB_REF !== `refs/tags/${tag}`
  ) {
    throw new Error(
      "Release promotion is supported only by the tag-triggered protected GitHub Actions job.",
    );
  }
  if (!environment.NODE_AUTH_TOKEN || !environment.GH_TOKEN) {
    throw new Error(
      "Release promotion requires the protected npm publication identity and GitHub job token.",
    );
  }
  return tag;
}

function spawnCommand(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw new PromotionCommandError({
      command,
      args,
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error.message,
      cause: result.error,
    });
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function main(): Promise<void> {
  const [releaseDir, packagesDir] = process.argv.slice(2);
  if (!releaseDir || !packagesDir) {
    throw new Error(
      "Usage: bun scripts/release-promote.ts <release-dir> <packages-dir>",
    );
  }
  const tag = assertProtectedPromotionInvocation(process.env);
  const candidate = loadApprovedCandidate({
    expectedTag: tag,
    releaseDir,
    packagesDir,
  });
  await promoteApprovedCandidate(
    candidate,
    createCliPromotionPort(spawnCommand),
  );
  console.log(
    `Promoted ${candidate.tag}: ${candidate.packages.length} npm packages and ${candidate.assets.length} GitHub assets are present.`,
  );
}

if (import.meta.main) await main();
