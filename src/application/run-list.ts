import {
  deriveRunFacts,
  type RunProjectionDependencies,
} from "./run-projection.js";
import type {
  RunListGroup,
  RunListRow,
  RunListSnapshot,
} from "./projection-port.js";

// The Previous Runs join (#87), beside `run-projection.ts`. It reads the Run
// Store's registrations and each Run's canonical record, re-derives the Bundle's
// human name from the pinned bytes, and pages the result newest-first — grouped
// Today / Yesterday / Older — into the normalized client contract. It never
// acquires a Run owner (that bumps the fencing epoch and would abort a live Run):
// the name and activity time come from the record alone (`RunListing` carries
// only `{runId, live}`), so listing a Workspace's Runs never touches one that is
// executing.

/** Bounded page size for the Previous Runs list (#87). Newest-first; the caller
 *  pages older with the returned cursor. */
const PAGE_SIZE = 20;

export interface RunListOptions {
  readonly resumable: boolean;
  readonly before?: string;
  /** The reference instant for Today / Yesterday / Older grouping. */
  readonly now: Date;
}

/** Build the bounded `run-list` snapshot for the launch Workspace's Run group. */
export function listRunsSnapshot(
  deps: RunProjectionDependencies,
  options: RunListOptions,
): RunListSnapshot {
  const filter = options.resumable ? "resumable" : "all";
  // The activity time and name come from each Run's record — never an acquired
  // owner — so the list never fences an executing Run. The name is cached by
  // digest, since a Workspace's Runs often share one Bundle.
  const nameByDigest = new Map<string, string>();
  const rows: { runId: string; bundleName: string; activityAt: string }[] = [];
  for (const listing of deps.runGroup.listRuns()) {
    const read = deps.runGroup.readRun(listing.runId);
    // A registered Run whose record will not read is skipped from the list; it can
    // still be shown or deleted by id on the exact `run` Projection.
    if (!read.ok) continue;
    const record = read.run;
    // The Resumable filter is `halted` and `failed` — both stored states, so no
    // per-Run derivation is needed (a `blocked` Run is answered, not resumed).
    if (
      options.resumable &&
      record.state !== "halted" &&
      record.state !== "failed"
    ) {
      continue;
    }
    let bundleName = nameByDigest.get(record.bundleSnapshotDigest);
    if (bundleName === undefined) {
      const derived = deriveRunFacts(deps, record.bundleSnapshotDigest);
      // Fall back to the digest when the pinned bytes are gone, so the row still
      // names the Run rather than dropping it.
      bundleName =
        "facts" in derived ? derived.facts.name : record.bundleSnapshotDigest;
      nameByDigest.set(record.bundleSnapshotDigest, bundleName);
    }
    rows.push({
      runId: listing.runId,
      bundleName,
      // M2 activity time is the Run's creation; a per-Attempt "latest activity"
      // needs a Store timestamp the record does not yet carry.
      // ponytail: use `createdAt`; add a `updatedAt` to run.db and read it here if
      // ordering by last Attempt (not launch) ever matters.
      activityAt: record.createdAt,
    });
  }

  // A stable total order: newest activity first, ties broken by Run id descending.
  // The `before` cursor names a concrete boundary row, so paging never shifts or
  // duplicates even when a newer Run is added at the top.
  rows.sort((a, b) => compareRows(b, a));

  const anchor =
    options.before === undefined ? undefined : decodeCursor(options.before);
  const older =
    anchor === undefined
      ? rows
      : rows.filter((row) => compareRows(row, anchor) < 0);

  const page = older.slice(0, PAGE_SIZE);
  const hasMore = older.length > PAGE_SIZE;
  const last = page[page.length - 1];
  const grouped: RunListRow[] = page.map((row) => ({
    ...row,
    group: dayGroup(new Date(row.activityAt), options.now),
  }));

  return {
    family: "run-list",
    filter,
    rows: grouped,
    // The final page (no older rows) reaches the beginning of history.
    beginningOfHistory: !hasMore,
    empty: rows.length === 0,
    ...(hasMore && last !== undefined
      ? { nextCursor: encodeCursor(last) }
      : {}),
  };
}

interface Boundary {
  readonly activityAt: string;
  readonly runId: string;
}

/** Order two rows by (activityAt, runId) ascending; the caller reverses for
 *  newest-first, and compares a row against the cursor boundary for paging. */
function compareRows(a: Boundary, b: Boundary): number {
  if (a.activityAt !== b.activityAt) {
    return a.activityAt < b.activityAt ? -1 : 1;
  }
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? -1 : 1;
}

/** Encode the boundary row a page ends at into an opaque, stable cursor. */
function encodeCursor(boundary: Boundary): string {
  return Buffer.from(
    JSON.stringify([boundary.activityAt, boundary.runId]),
  ).toString("base64url");
}

/** Decode a cursor, or a defensively-empty boundary that pages nothing when the
 *  cursor is not one this list produced (garbage in never throws). */
function decodeCursor(cursor: string): Boundary {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { activityAt: parsed[0], runId: parsed[1] };
    }
  } catch {
    // fall through
  }
  // An unparseable cursor anchors before the oldest possible row, so it returns an
  // empty page rather than the whole list or a throw.
  return { activityAt: "", runId: "" };
}

/** Which day bucket `at` falls in relative to `now`, by local calendar date. */
function dayGroup(at: Date, now: Date): RunListGroup {
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  return "older";
}
