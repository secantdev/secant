import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_TARGETS,
  checkMigrationJournal,
  checkMigrationRegistry,
} from "../../scripts/check-migrations.js";
import { makeTempDir } from "../helpers/tempDir.js";

// Assert the registry embed and the journal derivation in-process against the
// real migration tree. The whole-gate `bun run migrations:check` also runs
// drizzle-kit's schema diff, but that is the gate's own first step; re-spawning
// it here cost 12.7 s and blew Bun's default 5 s test timeout under a bare
// `bun test tests/architecture`, so the deterministic checks run in-process and
// the subprocess is left to the gate.
test("every declared database schema embeds and journals its migrations", () => {
  for (const target of DEFAULT_TARGETS) {
    assert.deepEqual(
      checkMigrationRegistry({
        migrationsDirectory: target.migrationsDirectory,
        registryPath: target.registryPath,
      }),
      [],
      target.migrationsDirectory,
    );
    assert.deepEqual(
      checkMigrationJournal({
        migrationsDirectory: target.migrationsDirectory,
        journal: target.journal,
      }),
      [],
      target.migrationsDirectory,
    );
  }
});

test("a journal timestamp that drifts from its directory name fails", () => {
  const temp = makeTempDir("secant-migration-journal-");
  const directory = "20260915092407_initial";
  mkdirSync(join(temp, directory));
  writeFileSync(join(temp, directory, "migration.sql"), "SELECT 1;");

  const errors = checkMigrationJournal({
    migrationsDirectory: temp,
    // A hand-typed timestamp 800 s off the folder name is the #116 drift shape.
    journal: [{ name: "initial", timestamp: 1_789_466_000_000, sql: "" }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /does not match its directory name/);
});

test("an ungenerated schema change fails with the regeneration message", () => {
  const temp = makeTempDir("secant-migration-check-");
  const migrations = join(temp, "migrations");
  cpSync(join(process.cwd(), "src", "drizzle", "catalog"), migrations, {
    recursive: true,
  });

  const sqliteCore = pathToFileURL(
    join(
      process.cwd(),
      "node_modules",
      "drizzle-orm",
      "sqlite-core",
      "index.js",
    ),
  ).href;
  const existingSchema = readFileSync(
    join(process.cwd(), "src", "catalog", "schema.ts"),
    "utf8",
  ).replace('"drizzle-orm/sqlite-core"', JSON.stringify(sqliteCore));
  const schema = join(temp, "schema.ts");
  writeFileSync(
    schema,
    `${existingSchema}\nexport const ungenerated = sqliteTable("ungenerated", { id: text("id").primaryKey() });\n`,
  );
  const config = join(temp, "drizzle.config.ts");
  writeFileSync(
    config,
    `export default ${JSON.stringify({ dialect: "sqlite", schema, out: migrations })};\n`,
  );

  const result = spawnSync(
    process.execPath,
    ["scripts/check-migrations.ts", config],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Schema has changes not captured in migrations!/);
  assert.match(result.stderr, /Run: bun run migrations:generate/);
});

test("a generated migration missing from its embedded registry fails", () => {
  const temp = makeTempDir("secant-migration-registry-");
  const first = join(temp, "20260915092407_initial");
  const second = join(temp, "20260915093000_add_column");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "migration.sql"), "SELECT 1;");
  writeFileSync(join(second, "migration.sql"), "SELECT 2;");
  const registry = join(temp, "migrations.ts");
  writeFileSync(
    registry,
    'import initial from "./20260915092407_initial/migration.sql" with { type: "text" };\n',
  );

  assert.deepEqual(
    checkMigrationRegistry({
      migrationsDirectory: temp,
      registryPath: registry,
    }),
    [
      "20260915093000_add_column/migration.sql is not embedded in migrations.ts",
    ],
  );
});
