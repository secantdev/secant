#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

type TMigrationTarget = {
  readonly config: string;
  readonly migrationsDirectory: string;
  readonly registryPath: string;
};

type TRegistryCheckParams = {
  readonly migrationsDirectory: string;
  readonly registryPath: string;
};

const DEFAULT_TARGETS: readonly TMigrationTarget[] = [
  {
    config: "drizzle.catalog.config.ts",
    migrationsDirectory: "src/drizzle/catalog",
    registryPath: "src/drizzle/migrations.ts",
  },
  {
    config: "drizzle.coordination.config.ts",
    migrationsDirectory: "src/drizzle/coordination",
    registryPath: "src/drizzle/migrations.ts",
  },
  {
    config: "drizzle.run.config.ts",
    migrationsDirectory: "src/drizzle/run",
    registryPath: "src/drizzle/migrations.ts",
  },
] as const;

export function checkMigrationRegistry(params: TRegistryCheckParams): string[] {
  const registry = readFileSync(params.registryPath, "utf8");
  const migrationDirectories = readdirSync(params.migrationsDirectory, {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(
          join(params.migrationsDirectory, entry.name, "migration.sql"),
        ),
    )
    .map((entry) => entry.name)
    .sort();

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
      const registryErrors = checkMigrationRegistry({
        migrationsDirectory: target.migrationsDirectory,
        registryPath: target.registryPath,
      });
      if (registryErrors.length > 0) {
        fail(target.config, registryErrors.join("\n"));
      }
    }
  }

  console.log("Migrations are up to date");
}

if (import.meta.main) main();
