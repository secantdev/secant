import catalogInitial from "./catalog/20260915095848_chubby_vanisher/migration.sql" with { type: "text" };
import coordinationInitial from "./coordination/20260915095850_yellow_forge/migration.sql" with { type: "text" };
import runInitial from "./run/20260915095853_hesitant_silverclaw/migration.sql" with { type: "text" };
import runPendingGate from "./run/20260916030347_mighty_vivisector/migration.sql" with { type: "text" };
import runHarnessTurns from "./run/20260916112916_cooing_squadron_supreme/migration.sql" with { type: "text" };
import type { MigrationsJournal } from "drizzle-orm/migrator";

// These first drizzle-kit migrations establish the complete schemas. Their
// generated CREATE statements are kept idempotent so a home from the immediately
// preceding release (same tables, no Drizzle journal) can adopt the journal at
// open; they also retain the STRICT tables that release created. Later schema
// changes remain ordinary generated diffs.
export const catalogMigrations: MigrationsJournal = [
  {
    name: "chubby_vanisher",
    timestamp: 1_789_466_328_000,
    sql: catalogInitial,
  },
];

export const coordinationMigrations: MigrationsJournal = [
  {
    name: "yellow_forge",
    timestamp: 1_789_466_330_000,
    sql: coordinationInitial,
  },
];

export const runMigrations: MigrationsJournal = [
  {
    name: "hesitant_silverclaw",
    timestamp: 1_789_466_333_000,
    sql: runInitial,
  },
  {
    name: "mighty_vivisector",
    timestamp: 1_789_527_827_000,
    sql: runPendingGate,
  },
  {
    name: "cooing_squadron_supreme",
    timestamp: 1_789_557_356_000,
    sql: runHarnessTurns,
  },
];
