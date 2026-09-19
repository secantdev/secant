#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CandidateManifest } from "./assemble.js";
import { MANIFEST_FILE } from "./assemble.js";

// The tag-admission and protected-release boundary (#158, spec #137 stories 82/90/94/
// 96/97 and the "Release artifact set and publication workflow" decisions): a `v*` tag
// is eligible only when it exactly equals the package version, and the release-approval
// job that gates the protected `release` environment writes the reviewer's approval
// summary — tag, commit, version, candidate digests, blocking jobs, checklist
// reference, and the Windows Terminal evidence trigger decision — before any human
// approves. Nothing here publishes; publication of the bytes is #159.
//
// The eligibility and Windows-Terminal-trigger logic is pure (`tagMatchesVersion`,
// `windowsTerminalTrigger`, `formatApprovalSummary`) and unit-tested in
// tests/release/release-gate.test.ts; only the git/env/fs wiring runs in the CI job.
// The deterministic release-protection policy check
// (tests/architecture/check-release-workflow.ts) proves the workflow's tag gating,
// dependency edges, environment placement, and credential boundaries.

/** The candidate-check jobs that must gate the protected promotion, named for the
 *  approval summary. The policy check independently proves the promotion job
 *  transitively depends on every one of them; this list is the reviewer-facing copy. */
export const CANDIDATE_CHECK_JOBS = [
  "check",
  "build",
  "smoke",
  "release-archive-consumer",
  "platform-package-consumer",
  "npm-launcher-consumer",
  "powershell-installer-consumer",
  "posix-installer-consumer",
  "terminal",
];

/** The version a `v*` tag ref names, or null when the ref is not a release tag. */
export function parseTagVersion(ref: string): string | null {
  const match = /^refs\/tags\/v(.+)$/.exec(ref);
  return match ? match[1]! : null;
}

export interface TagVerdict {
  readonly ok: boolean;
  readonly reason: string;
}

/** A tag authorizes promotion only when it exactly matches the package version, so an
 *  earlier branch run or a mismatched tag cannot reach the protected environment. */
export function tagMatchesVersion(
  ref: string,
  packageVersion: string,
): TagVerdict {
  const tagVersion = parseTagVersion(ref);
  if (tagVersion === null) {
    return { ok: false, reason: `Ref ${ref} is not a v* release tag.` };
  }
  if (tagVersion !== packageVersion) {
    return {
      ok: false,
      reason: `Tag v${tagVersion} does not match package version ${packageVersion}.`,
    };
  }
  return {
    ok: true,
    reason: `Tag v${tagVersion} matches package version ${packageVersion}.`,
  };
}

/** The inputs whose change since the previous tag re-arms the human Windows Terminal
 *  check (ADR 0027 amendment / spec #137 story 94): the Bun pin, the @opentui/core
 *  pin, and the renderer. */
export interface TerminalInputs {
  readonly bunPin: string;
  readonly openTuiPin: string;
}

/** Extract the two package.json-borne terminal inputs, tolerant of a missing field. */
export function terminalInputs(pkg: unknown): TerminalInputs {
  const record =
    typeof pkg === "object" && pkg !== null
      ? (pkg as Record<string, unknown>)
      : {};
  const deps =
    typeof record.dependencies === "object" && record.dependencies !== null
      ? (record.dependencies as Record<string, unknown>)
      : {};
  return {
    bunPin:
      typeof record.packageManager === "string" ? record.packageManager : "",
    openTuiPin:
      typeof deps["@opentui/core"] === "string"
        ? (deps["@opentui/core"] as string)
        : "",
  };
}

export interface TerminalTrigger {
  readonly fresh: boolean;
  readonly reason: string;
}

/** Whether fresh Windows Terminal evidence is required. The first release always
 *  requires it; afterwards it is required only when a triggering input changed since
 *  the previous tag, otherwise the prior report may be carried forward (story 95). */
export function windowsTerminalTrigger(
  previousTag: string | null,
  previous: TerminalInputs | null,
  current: TerminalInputs,
  rendererChanged: boolean,
): TerminalTrigger {
  if (previousTag === null) {
    return {
      fresh: true,
      reason: "First release: fresh Windows Terminal evidence required.",
    };
  }
  if (previous === null) {
    // A prior tag exists but its package.json could not be read or parsed. Fail
    // safe by requiring fresh evidence, and say so honestly rather than pretending
    // this is a first release.
    return {
      fresh: true,
      reason: `Could not read the previous tag (${previousTag}); requiring fresh Windows Terminal evidence.`,
    };
  }
  const changed: string[] = [];
  if (previous.bunPin !== current.bunPin) changed.push("Bun pin");
  if (previous.openTuiPin !== current.openTuiPin)
    changed.push("@opentui/core pin");
  if (rendererChanged) changed.push("src/tui/renderer/");
  if (changed.length > 0) {
    return {
      fresh: true,
      reason: `Fresh Windows Terminal evidence required; changed since ${previousTag}: ${changed.join(", ")}.`,
    };
  }
  return {
    fresh: false,
    reason: `Windows Terminal evidence may be carried forward from ${previousTag}; no triggering input changed.`,
  };
}

export interface ApprovalSummaryFields {
  readonly tag: string;
  readonly commit: string;
  readonly version: string;
  readonly manifest: CandidateManifest;
  readonly terminalTrigger: TerminalTrigger;
}

/** The one reviewer-visible approval summary the protected `release` environment gates
 *  on. It names the exact bytes and evidence being approved (acceptance #158). */
export function formatApprovalSummary(fields: ApprovalSummaryFields): string {
  const digestLines = fields.manifest.targets
    .map(
      (target) =>
        `  - ${target.key}: archive \`${target.archiveSha256}\`, binary \`${target.binarySha256}\``,
    )
    .join("\n");
  return `## Release promotion: ${fields.tag}

Approving the protected \`release\` environment promotes exactly these bytes and
evidence. Publication itself is a later step (#159); this is the human gate.

- Tag: ${fields.tag}
- Commit: ${fields.commit}
- Package version: ${fields.version}
- Candidate digests:
${digestLines}
  - LICENSE: \`${fields.manifest.licenseSha256}\`
  - THIRD-PARTY-NOTICES.md: \`${fields.manifest.noticesSha256}\`
- Blocking jobs (all must be green before this environment is reachable): ${CANDIDATE_CHECK_JOBS.join(", ")}
- Checklist: docs/release-checklist.md
- Windows Terminal evidence: ${fields.terminalTrigger.reason}`;
}

function git(args: string[]): string | null {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/** The highest `v*` tag that is not the current one, or null when this is the first. */
function previousReleaseTag(currentTag: string): string | null {
  const listed = git(["tag", "--list", "v*", "--sort=-v:refname"]);
  if (listed === null) return null;
  for (const tag of listed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    if (tag !== currentTag) return tag;
  }
  return null;
}

async function main(): Promise<void> {
  const releaseDir = process.argv[2] ?? "dist/release";
  const ref = process.env.GITHUB_REF ?? "";
  const commit =
    process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"]) ?? "unknown";
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    version: string;
  };

  const verdict = tagMatchesVersion(ref, pkg.version);
  if (!verdict.ok) {
    throw new Error(
      `${verdict.reason} A tag authorizes promotion only when it exactly matches the package version; no branch run substitutes.`,
    );
  }
  const tag = `v${pkg.version}`;

  // Windows Terminal trigger: compare the terminal inputs against the previous tag.
  // A git failure fails safe by requiring fresh evidence.
  const previousTag = previousReleaseTag(tag);
  let previous: TerminalInputs | null = null;
  let rendererChanged = true;
  if (previousTag !== null) {
    const priorPkg = git(["show", `${previousTag}:package.json`]);
    // A missing or malformed historic package.json leaves `previous` null, which
    // fails safe to fresh-required with an honest reason rather than crashing.
    if (priorPkg !== null) {
      try {
        previous = terminalInputs(JSON.parse(priorPkg));
      } catch {
        previous = null;
      }
    }
    const changed = git([
      "diff",
      "--name-only",
      `${previousTag}..HEAD`,
      "--",
      "src/tui/renderer",
    ]);
    rendererChanged = changed === null ? true : changed.length > 0;
  }
  const terminalTrigger = windowsTerminalTrigger(
    previousTag,
    previous,
    terminalInputs(pkg),
    rendererChanged,
  );

  const manifestPath = join(releaseDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Candidate manifest missing: ${manifestPath}. The release-approval job downloads the assembled candidate; it never rebuilds it.`,
    );
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as CandidateManifest;
  if (manifest.version !== pkg.version) {
    throw new Error(
      `Candidate manifest version ${manifest.version} does not match the tag version ${pkg.version}.`,
    );
  }

  const summary = formatApprovalSummary({
    tag,
    commit,
    version: pkg.version,
    manifest,
    terminalTrigger,
  });
  console.log(summary);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, `${summary}\n`);
}

if (import.meta.main) {
  await main();
}
