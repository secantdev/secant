import catalogInitial from "./catalog/20260915095848_chubby_vanisher/migration.sql" with { type: "text" };
import coordinationInitial from "./coordination/20260915095850_yellow_forge/migration.sql" with { type: "text" };
import coordinationRunRegistrationOnly from "./coordination/20260918034609_white_alex_power/migration.sql" with { type: "text" };
import runInitial from "./run/20260915095853_hesitant_silverclaw/migration.sql" with { type: "text" };
import runPendingGate from "./run/20260916030347_mighty_vivisector/migration.sql" with { type: "text" };
import runHarnessTurns from "./run/20260916112916_cooing_squadron_supreme/migration.sql" with { type: "text" };
import runTurnKind from "./run/20260917052606_ambiguous_the_hand/migration.sql" with { type: "text" };
import runHarnessIdentity from "./run/20260917061423_easy_iceman/migration.sql" with { type: "text" };
import runOwnership from "./run/20260918034612_curvy_piledriver/migration.sql" with { type: "text" };
import runSteerCapability from "./run/20260918050415_sudden_black_tom/migration.sql" with { type: "text" };
import runSelectedHarness from "./run/20260918104828_ancient_rocket_racer/migration.sql" with { type: "text" };
import runRequestedModel from "./run/20260922090555_superb_lily_hollister/migration.sql" with { type: "text" };
import type { MigrationsJournal } from "drizzle-orm/migrator";

// A migration's journal `name` and `timestamp` are the two load-bearing fields
// drizzle applies by: the migrator dedupes on `name` and orders by `timestamp`.
// Both are derived here from the generated `YYYYMMDDHHmmss_slug` directory name
// so a journal entry can never drift from the folder it embeds (the hand-typed
// pairs did: #116's `cooing_squadron_supreme` carried a timestamp 800 s off its
// directory). `check-migrations.ts` re-derives the same pair and fails on any
// mismatch, missing entry or extra entry.
const MIGRATION_DIRECTORY = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_(.+)$/;

export function journalEntry(
  directory: string,
  sql: string,
): MigrationsJournal[number] {
  const match = MIGRATION_DIRECTORY.exec(directory);
  if (!match) {
    throw new Error(`Malformed migration directory name: ${directory}`);
  }
  const [, year, month, day, hour, minute, second, name] = match;
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return { name: name!, timestamp, sql };
}

// These first drizzle-kit migrations establish the complete schemas. Their
// generated CREATE statements are kept idempotent so a home from the immediately
// preceding release (same tables, no Drizzle journal) can adopt the journal at
// open; they also retain the STRICT tables that release created. Later schema
// changes remain ordinary generated diffs.
export const catalogMigrations: MigrationsJournal = [
  journalEntry("20260915095848_chubby_vanisher", catalogInitial),
];

export const coordinationMigrations: MigrationsJournal = [
  journalEntry("20260915095850_yellow_forge", coordinationInitial),
  journalEntry(
    "20260918034609_white_alex_power",
    coordinationRunRegistrationOnly,
  ),
];

export const runMigrations: MigrationsJournal = [
  journalEntry("20260915095853_hesitant_silverclaw", runInitial),
  journalEntry("20260916030347_mighty_vivisector", runPendingGate),
  journalEntry("20260916112916_cooing_squadron_supreme", runHarnessTurns),
  journalEntry("20260917052606_ambiguous_the_hand", runTurnKind),
  journalEntry("20260917061423_easy_iceman", runHarnessIdentity),
  journalEntry("20260918034612_curvy_piledriver", runOwnership),
  journalEntry("20260918050415_sudden_black_tom", runSteerCapability),
  journalEntry("20260918104828_ancient_rocket_racer", runSelectedHarness),
  journalEntry("20260922090555_superb_lily_hollister", runRequestedModel),
];
