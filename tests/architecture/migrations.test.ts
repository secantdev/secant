import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { checkMigrationRegistry } from "../../scripts/check-migrations.js";
import { makeTempDir } from "../helpers/tempDir.js";

test("every declared database schema has generated migrations", () => {
  const result = spawnSync(process.execPath, ["run", "migrations:check"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Migrations are up to date/);
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
