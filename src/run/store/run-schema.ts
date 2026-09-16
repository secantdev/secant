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
  state: text("state").notNull(),
  created_at: text("created_at").notNull(),
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
});

export const attemptLog = sqliteTable("attempt_log", {
  seq: integer("seq").primaryKey(),
  attempt_id: text("attempt_id").notNull(),
  outcome: text("outcome").notNull(),
  at: text("at").notNull(),
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
  raised_at: text("raised_at").notNull(),
});
