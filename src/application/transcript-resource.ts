import type { RunOwner } from "../run/store/store.js";
import { runSessionNotFound, runTranscriptCursorInvalid } from "./problems.js";
import { transcriptView } from "./run-projection.js";
import type {
  TranscriptExportReference,
  TranscriptPageReference,
  TranscriptRead,
} from "./projection-port.js";

// Resolves the transcript `page` and `export` Resource References (#124) against
// an acquired Run Store owner. The Store owns stable paging (`transcriptPage`
// reads only the requested page); this seam validates the reference, wraps the
// store sequence in an opaque cursor, and narrows the store rows to the client
// view. No store row id or native Session id crosses the Port: the cursor is
// base64url over the Application's own sequence, decoded only here.

/** Entries per bounded transcript page. A page is a handful of Turns, small
 *  enough that inspecting one never reads the whole transcript. Exported so the
 *  multi-page tests seed just past a page without hard-coding the size. */
export const TRANSCRIPT_PAGE_SIZE = 20;

export function readTranscriptResource(
  owner: RunOwner,
  reference: TranscriptPageReference | TranscriptExportReference,
): TranscriptRead {
  // A Session with a transcript is always a recorded Harness Session (admitting a
  // Turn upserts it), so an unknown Session name is a reference to nothing.
  const known = owner
    .harnessSessions()
    .some((s) => s.session === reference.session);
  if (!known) {
    return {
      found: false,
      problem: runSessionNotFound(reference.runId, reference.session),
    };
  }

  if (reference.type === "transcript-export") {
    const entries = owner
      .transcript()
      .filter((entry) => entry.session === reference.session)
      .map(transcriptView);
    return { found: true, type: "transcript-export", entries };
  }

  let before: number | undefined;
  if (reference.older !== undefined) {
    before = decodeCursor(reference.older);
    if (before === undefined) {
      return {
        found: false,
        problem: runTranscriptCursorInvalid(reference.runId, reference.session),
      };
    }
  }
  const page = owner.transcriptPage({
    session: reference.session,
    limit: TRANSCRIPT_PAGE_SIZE,
    ...(before !== undefined ? { before } : {}),
  });
  return {
    found: true,
    type: "transcript-page",
    entries: page.entries.map(transcriptView),
    // The next older page starts before this page's oldest entry; only emit a
    // cursor when older retained entries actually exist.
    ...(page.hasOlder && page.entries[0] !== undefined
      ? { older: encodeCursor(page.entries[0].seq) }
      : {}),
  };
}
/** The opaque `older` cursor: base64url over the store sequence. Opaque to
 *  clients, decoded only here — the raw sequence never crosses the Port. */
function encodeCursor(seq: number): string {
  return Buffer.from(JSON.stringify(seq)).toString("base64url");
}

/** Decode a cursor this seam produced, or undefined for anything else (a stale or
 *  forged cursor becomes a normalized Problem, never a throw or a wrong page). */
function decodeCursor(cursor: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    // Store sequences are positive integers, so anything else is a forged or
    // corrupted cursor — a Problem, never a silently-empty page.
    return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
