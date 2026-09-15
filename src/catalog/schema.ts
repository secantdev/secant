import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const workspaceApprovals = sqliteTable("workspace_approvals", {
  path: text("path").primaryKey(),
  approved_at: text("approved_at").notNull(),
});

export const catalogEntries = sqliteTable(
  "catalog_entries",
  {
    id: text("id").notNull(),
    version: text("version").notNull(),
    digest: text("digest").notNull(),
    origin_kind: text("origin_kind").notNull(),
    origin_location: text("origin_location").notNull(),
    installed_at: text("installed_at").notNull(),
    installation_generation: integer("installation_generation").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.version] })],
);

export const trustGrants = sqliteTable(
  "trust_grants",
  {
    digest: text("digest").notNull(),
    installation_generation: integer("installation_generation").notNull(),
    operation_id: text("operation_id").notNull(),
    granted_at: text("granted_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.digest, table.installation_generation] }),
  ],
);
