import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const runRecord = sqliteTable("run_record", {
  run_id: text("run_id").primaryKey(),
  workspace_path: text("workspace_path").notNull(),
  bundle_snapshot_digest: text("bundle_snapshot_digest").notNull(),
  launch: text("launch").notNull(),
  // Nullable only for Command-only Runs and Runs created before M4. Agent-bearing
  // Runs created from M4 onward pin their semantic Harness at creation.
  selected_harness: text("selected_harness"),
  // The immutable requested model pinned at launch, applied at each Adapter's native
  // point through prepare (#187). Free text, never validated to a closed set here.
  // Null when the launch requested no model (the Harness default is used, never a
  // substitute) and for a Command-only Run, which prepares no Harness.
  requested_model: text("requested_model"),
  state: text("state").notNull(),
  created_at: text("created_at").notNull(),
});

// One row per Run Store. The fixed singleton key makes the invariant structural;
// an absent row is the legacy representation of an unowned Run at epoch zero.
export const runOwner = sqliteTable("run_owner", {
  singleton: integer("singleton").primaryKey(),
  ownerEpoch: integer("owner_epoch").notNull(),
  ownerPid: integer("owner_pid"),
});

export const artifactVersions = sqliteTable(
  "artifact_version",
  {
    version_id: text("version_id").notNull(),
    artifact_name: text("artifact_name").notNull(),
    artifact_type: text("artifact_type").notNull(),
    attempt_id: text("attempt_id").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.version_id, table.artifact_name] })],
);

export const artifactBindings = sqliteTable("artifact_binding", {
  artifact_name: text("artifact_name").primaryKey(),
  version_id: text("version_id").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const attempts = sqliteTable("attempt", {
  attempt_id: text("attempt_id").primaryKey(),
  outcome: text("outcome").notNull(),
  version_id: text("version_id"),
  settled_at: text("settled_at").notNull(),
  // The effective model an Agent-step Attempt ran under, reported by the Harness
  // init message (#116). Null for a Command/Gate Attempt, which runs no Harness.
  effective_model: text("effective_model"),
  // The normalized Harness identity an Agent-step Attempt qualified under, from the
  // prepared Harness profile (#125): the Harness name, the resolved executable, and
  // the observed executable version. Recorded together so the identity survives
  // reopening and resume. All null for a Command/Gate Attempt, which runs no Harness;
  // `harness` non-null marks an Agent-step Attempt.
  harness: text("harness"),
  executable: text("executable"),
  executable_version: text("executable_version"),
  steer_available: integer("steer_available", { mode: "boolean" }),
  steer_evidence: text("steer_evidence"),
});

export const attemptLog = sqliteTable("attempt_log", {
  seq: integer("seq").primaryKey(),
  attempt_id: text("attempt_id").notNull(),
  outcome: text("outcome").notNull(),
  at: text("at").notNull(),
  // Set on the interactive Attempt a human's confirmed End Stage settled (#218): the
  // human declared the human-controlled Repeat's stage complete. Null for every other
  // Attempt, including a Continue, and for rows logged before the column existed.
  stage_ended: integer("stage_ended", { mode: "boolean" }),
});

export const materializationConflicts = sqliteTable(
  "materialization_conflict",
  {
    seq: integer("seq").primaryKey(),
    diagnostic_id: text("diagnostic_id").notNull(),
    artifact_name: text("artifact_name").notNull(),
    artifact_path: text("artifact_path").notNull(),
    version_id: text("version_id").notNull(),
    at: text("at").notNull(),
  },
);

export const gateAnswers = sqliteTable("gate_answer", {
  seq: integer("seq").primaryKey(),
  answer_id: text("answer_id").notNull(),
  operation_id: text("operation_id").notNull().unique(),
  gate_attempt_id: text("gate_attempt_id").notNull(),
  answer: text("answer").notNull(),
  iterations_at_grant: integer("iterations_at_grant").notNull(),
  version_id: text("version_id").notNull(),
  at: text("at").notNull(),
});

// An authored Human Gate Step the walk paused at (#108): a durable record that
// the Run rests `blocked` at this gate, distinct from a derived Review checkpoint
// (which writes nothing and re-derives its gate from the attempt log). The
// producing Attempt id is the key; the gate is "pending" until that Attempt
// settles — answering settles it through the normal publication path. The output
// artifact name is present only for a `free-text` gate.
export const pendingGates = sqliteTable("pending_gate", {
  attempt_id: text("attempt_id").primaryKey(),
  step_id: text("step_id").notNull(),
  shape: text("shape").notNull(),
  message: text("message").notNull(),
  output_artifact_name: text("output_artifact_name"),
  // A free-text gate's authored suggestions as a JSON string array (#213); null
  // for a gate without them and for every row raised before the column existed.
  suggestions: text("suggestions"),
  raised_at: text("raised_at").notNull(),
});

// One named Harness Session a Run opens (#116). `session_key` is the Bundle's
// named `session` (or a per-Attempt `fresh-<attempt>` key for the reserved
// `FRESH_SESSION` name the Workflow Module owns); the native
// conversation id crosses the Seam only as the opaque recovery coordinate stored
// here. `availability` is the last observed Session state (`open`/`detached`/
// `unusable`); `availability_detail` carries a detached coordinate or an unusable
// reason. Upserted as Turns admit and settle. `profile_digest` is declared surface
// awaiting its caller: a later slice (Session recovery/requalification) will record
// the Harness profile a Session was prepared under here to detect drift across a
// resume; M3 has no recovery, so it is written null.
export const harnessSessions = sqliteTable("harness_session", {
  session_key: text("session_key").primaryKey(),
  native_session_id: text("native_session_id"),
  availability: text("availability").notNull(),
  availability_detail: text("availability_detail"),
  harness: text("harness").notNull(),
  profile_digest: text("profile_digest"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

// One Turn admitted in a Session (#116). The row is written before the stdin frame
// is sent (durable admission the Adapter awaits): a write failure proves the Turn
// `not-started`. `input` is the exact rendered transcript input. `result_kind` and
// `result_detail` stay null until the Turn settles, and a settled result is
// immutable (settle only writes when `result_kind` is still null).
//
// `kind` is the Crucible Step kind that produced the Turn — `agent` or
// `interactive-agent` (#126) — recorded from the executing Step at admission, so
// reopened history distinguishes an Interactive Turn from an autonomous Agent Turn
// without inferring from the Run's current position. It is Crucible-owned durable
// truth, independent of `origin` (`managed`/`human`) and of any Harness-native type.
// Nullable: a Turn admitted before this column existed reads it back null — a legacy
// row whose kind is genuinely unknown, never fabricated to a guess.
export const turns = sqliteTable("turn", {
  turn_id: text("turn_id").primaryKey(),
  attempt_id: text("attempt_id").notNull(),
  session_key: text("session_key").notNull(),
  origin: text("origin").notNull(),
  kind: text("kind"),
  sequence: integer("sequence").notNull(),
  input: text("input").notNull(),
  admitted_at: text("admitted_at").notNull(),
  result_kind: text("result_kind"),
  result_detail: text("result_detail"),
  settled_at: text("settled_at"),
});

// One normalized durable Turn event (#116), append-only. `kind` is a Crucible Turn
// event kind (`assistant-content`, `tool-activity`, `session`, `model`, …) and
// `payload` its JSON detail. Ephemeral Harness Requests are not stored here.
export const turnEvents = sqliteTable("turn_event", {
  seq: integer("seq").primaryKey(),
  turn_id: text("turn_id").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  at: text("at").notNull(),
});

// One readable Session transcript entry (#116): the exact Turn input (`user`) and
// the authoritative assistant content (`assistant`), append-only.
export const transcriptEntries = sqliteTable("transcript_entry", {
  seq: integer("seq").primaryKey(),
  session_key: text("session_key").notNull(),
  turn_id: text("turn_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  at: text("at").notNull(),
});
