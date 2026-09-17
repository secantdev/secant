#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { MigrationsJournal } from "drizzle-orm/migrator";
import {
  catalogMigrations,
  coordinationMigrations,
  journalEntry,
  runMigrations,
} from "../src/drizzle/migrations.js";

type TMigrationTarget = {
  readonly config: string;
  readonly migrationsDirectory: string;
  readonly registryPath: string;
  readonly journal: MigrationsJournal;
};

type TRegistryCheckParams = {
  readonly migrationsDirectory: string;
  readonly registryPath: string;
};

type TJournalCheckParams = {
  readonly migrationsDirectory: string;
  readonly journal: MigrationsJournal;
};

export const DEFAULT_TARGETS: readonly TMigrationTarget[] = [
  {
    config: "drizzle.catalog.config.ts",
    migrationsDirectory: "src/drizzle/catalog",
    registryPath: "src/drizzle/migrations.ts",
    journal: catalogMigrations,
  },
  {
    config: "drizzle.coordination.config.ts",
    migrationsDirectory: "src/drizzle/coordination",
    registryPath: "src/drizzle/migrations.ts",
    journal: coordinationMigrations,
  },
  {
    config: "drizzle.run.config.ts",
    migrationsDirectory: "src/drizzle/run",
    registryPath: "src/drizzle/migrations.ts",
    journal: runMigrations,
  },
] as const;

function migrationDirectoryNames(migrationsDirectory: string): string[] {
  return readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(migrationsDirectory, entry.name, "migration.sql")),
    )
    .map((entry) => entry.name)
    .sort();
}

// The journal (`name`, `timestamp`) drizzle applies by must match, in order, the
// migration directories on disk with both fields derived from each folder name.
// `checkMigrationRegistry` proves each directory is *imported*; this proves the
// journal array that wraps those imports carries the correct derived pair and no
// stray or missing entry. A hand-typed `timestamp` that drifts from its folder
// (or a renamed slug) is caught here, not by the text scan.
export function checkMigrationJournal(params: TJournalCheckParams): string[] {
  const expected = migrationDirectoryNames(params.migrationsDirectory).map(
    (directory) => ({ directory, entry: journalEntry(directory, "") }),
  );
  const errors: string[] = [];
  if (params.journal.length !== expected.length) {
    errors.push(
      `journal has ${params.journal.length} entries for ${expected.length} migration directories`,
    );
  }
  for (let index = 0; index < expected.length; index++) {
    const { directory, entry } = expected[index]!;
    const actual = params.journal[index];
    if (!actual || actual.name !== entry.name) {
      errors.push(
        `journal entry ${index} is ${actual?.name ?? "missing"}, expected ${entry.name} (from ${directory})`,
      );
      continue;
    }
    if (actual.timestamp !== entry.timestamp) {
      errors.push(
        `${directory} journal timestamp ${actual.timestamp} does not match its directory name (${entry.timestamp})`,
      );
    }
  }
  return errors;
}

export function checkMigrationRegistry(params: TRegistryCheckParams): string[] {
  const registry = readFileSync(params.registryPath, "utf8");
  const migrationDirectories = migrationDirectoryNames(
    params.migrationsDirectory,
  );

  const errors: string[] = [];
  let previousPosition = -1;
  let reportedOrdering = false;
  for (const directory of migrationDirectories) {
    const migrationPath = `${directory}/migration.sql`;
    const position = registry.indexOf(migrationPath);
    if (position === -1) {
      errors.push(
        `${migrationPath} is not embedded in ${basename(params.registryPath)}`,
      );
      continue;
    }
    // Keep scanning for unembedded migrations after an ordering fault, but report
    // the ordering error only once.
    if (position < previousPosition && !reportedOrdering) {
      errors.push(
        `${basename(params.registryPath)} does not list migrations in generated order`,
      );
      reportedOrdering = true;
    }
    previousPosition = position;
  }
  return errors;
}

function fail(config: string, detail: string): never {
  console.error(`Schema has changes not captured in migrations! (${config})`);
  console.error("Run: bun run migrations:generate");
  if (detail.trim()) console.error(detail.trim());
  process.exit(1);
}

function checkConfig(config: string): void {
  const generated = spawnSync(
    process.execPath,
    [
      "drizzle-kit",
      "generate",
      "--config",
      config,
      "--explain",
      "--output",
      "json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (generated.status !== 0) {
    fail(config, generated.stderr || generated.stdout);
  }

  let result;
  try {
    result = JSON.parse(generated.stdout);
  } catch {
    fail(config, generated.stdout);
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("status" in result) ||
    result.status !== "no_changes"
  ) {
    fail(config, generated.stdout);
  }

  const checked = spawnSync(
    process.execPath,
    ["drizzle-kit", "check", "--config", config],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (checked.status !== 0) {
    fail(config, checked.stderr || checked.stdout);
  }
}

function main(): void {
  const configs = process.argv.slice(2);
  if (configs.length > 0) {
    for (const config of configs) checkConfig(config);
  } else {
    for (const target of DEFAULT_TARGETS) {
      checkConfig(target.config);
      const registryErrors = [
        ...checkMigrationRegistry({
          migrationsDirectory: target.migrationsDirectory,
          registryPath: target.registryPath,
        }),
        ...checkMigrationJournal({
          migrationsDirectory: target.migrationsDirectory,
          journal: target.journal,
        }),
      ];
      if (registryErrors.length > 0) {
        fail(target.config, registryErrors.join("\n"));
      }
    }
  }

  console.log("Migrations are up to date");
}

if (import.meta.main) main();
