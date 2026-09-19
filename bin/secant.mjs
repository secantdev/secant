#!/usr/bin/env node
// The thin, script-free npm launcher for `@secantdev/secant` (spec #137, ADR 0030).
//
// It runs under any Node the user already has and needs no install/postinstall
// step. Its only job is to find the per-platform package that npm or pnpm already
// installed IN PLACE — never downloading or copying a binary — and to exec that
// package's Secant executable, forwarding the arguments, working directory,
// environment, inherited stdio, the SIGINT/SIGTERM/SIGHUP signals, and the native
// exit status faithfully. It ships no candidate executable of its own.
//
// Pure Node built-ins by contract: the launcher must run before any Secant runtime
// exists, so it may not depend on this repo's TypeScript or Bun toolchain.
//
// Its `platforms.json` (the host key -> { package, executable } map) is generated
// at pack time from the one target manifest (scripts/targets.ts) by
// scripts/pack-launcher.ts, so this file restates none of that identity. The
// host key is `${process.platform}-${process.arch}` (e.g. `linux-x64`,
// `darwin-arm64`, `win32-x64`), matching npm's own os/cpu tokens.
//
// The signal-forwarding and exit-status shape follows OpenCode's `bin/opencode`
// (github.com/sst/opencode); the in-place, script-free resolution is Secant's own —
// OpenCode's postinstall binary-copy design is deliberately rejected (spec #137).

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Choose this host's platform package from the generated map, or throw a
 * before-spawn diagnostic naming the supported platforms. Pure, so it is the one
 * piece the launcher consumer drives directly.
 */
export function selectTarget(platforms, platform, arch) {
  const key = `${platform}-${arch}`;
  const entry = platforms[key];
  if (entry === undefined) {
    const supported = Object.keys(platforms).sort().join(", ");
    throw new Error(
      `Secant does not ship a binary for ${key}. Supported platforms: ${supported}.`,
    );
  }
  return { key, package: entry.package, executable: entry.executable };
}

/**
 * Resolve the absolute path of the installed executable for this host, or throw a
 * before-spawn diagnostic. `resolvePackageJson` resolves a platform package's
 * package.json exactly as Node would from the launcher's real location — which is
 * what makes pnpm's symlinked layout work — and is injectable for tests.
 */
export function resolveExecutable(options) {
  const { platforms, platform, arch, resolvePackageJson } = options;
  const target = selectTarget(platforms, platform, arch);
  let packageJsonPath;
  try {
    packageJsonPath = resolvePackageJson(target.package);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        `The Secant platform package ${target.package} is not installed. ` +
          `Reinstall @secantdev/secant so its optional dependency for ${target.key} is ` +
          `present; some package managers skip optional dependencies.`,
        { cause: error },
      );
    }
    // Any other resolution failure — permissions, a corrupted install, a symlink
    // loop, an unexpected exports restriction — is a real bug, not a normal missing
    // optional dependency, so surface the underlying cause rather than masking it.
    throw new Error(
      `Could not resolve the Secant platform package ${target.package}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  return join(dirname(packageJsonPath), target.executable);
}

/** Spawn the resolved executable, forwarding stdio, signals, and the exit status. */
function run(executable) {
  const child = spawn(executable, process.argv.slice(2), { stdio: "inherit" });

  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });

  const forwarders = {};
  for (const signal of FORWARDED_SIGNALS) {
    forwarders[signal] = () => {
      try {
        child.kill(signal);
      } catch {
        // The child may already have exited.
      }
    };
    process.on(signal, forwarders[signal]);
  }

  child.on("exit", (code, signal) => {
    for (const forwarded of FORWARDED_SIGNALS) {
      process.removeListener(forwarded, forwarders[forwarded]);
    }
    // A child killed by a signal is reproduced on this process, so a parent sees
    // the same cause of death; otherwise the child's exit code is the launcher's.
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(typeof code === "number" ? code : 0);
  });
}

/** The launcher, wired to the real filesystem. Reads `platforms.json` from beside
 *  this file (resolved through symlinks so pnpm's layout works) and resolves the
 *  platform package as Node would from that real location. */
function main() {
  const launcherFile = realpathSync(fileURLToPath(import.meta.url));
  const launcherDir = dirname(launcherFile);
  const platforms = JSON.parse(
    readFileSync(join(launcherDir, "platforms.json"), "utf8"),
  );
  const require = createRequire(pathToFileURL(launcherFile));
  const executable = resolveExecutable({
    platforms,
    platform: process.platform,
    arch: process.arch,
    resolvePackageJson: (name) => require.resolve(`${name}/package.json`),
  });
  run(executable);
}

// Only run when invoked as the program, not when imported by a test. Node resolves
// the bin symlink to this real file for `import.meta.url`, so compare against the
// canonicalized argv[1]. Any failure to canonicalize means this was not invoked as
// the program, so it stays imported-only rather than crashing at load.
function invokedAsProgram() {
  const invokedAs = process.argv[1];
  if (invokedAs === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invokedAs)).href;
  } catch {
    return false;
  }
}

if (invokedAsProgram()) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
