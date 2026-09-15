import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  run_id: text("run_id").primaryKey(),
  owner_epoch: integer("owner_epoch").notNull(),
  owner_pid: integer("owner_pid"),
  created_at: text("created_at").notNull(),
});

export const operations = sqliteTable("operations", {
  operation_id: text("operation_id").primaryKey(),
  kind: text("kind").notNull(),
  run_id: text("run_id").notNull(),
  recorded_at: text("recorded_at").notNull(),
});
