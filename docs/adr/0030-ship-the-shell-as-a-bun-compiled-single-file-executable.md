# Ship The Shell As A Bun-Compiled Single-File Executable

Secant's interactive shell ships as a **Bun-compiled single-file executable**, not a Node npm package. The
[runtime and distribution decision](https://github.com/secantdev/secant/issues/59#issuecomment-5618793207) takes this now and gates the ADR on a
Windows soak; that [soak passed](https://github.com/secantdev/secant/issues/60#issuecomment-5623212589), so this ADR stands. It supersedes the
runtime and distribution half of the [process/runtime decision](https://github.com/secantdev/secant/issues/21#issuecomment-5497308855) ("Node 24
LTS, one npm package, no self-contained executable in v1"), which rested on the disproven "Node needs no FFI" measurement in
[#6](https://github.com/secantdev/secant/issues/6); [ADR 0026](./0026-replace-legacy-devflow-in-place-by-wholesale-deletion.md)'s "realigned to
Node 24" sentence; [ADR 0027](./0027-gate-releases-on-three-os-ci-and-recorded-human-evidence.md)'s "one pinned Node version" and "publishes to
npm from CI" sentences; and [ADR 0018](./0018-adopt-opencode-presentation-as-pinned-reduced-vendor.md)'s legacy-conhost support claim, its
Bun-adoption conditional, and its conhost-targeted human release check (see that ADR's ADR 0030 amendment).

Node 26.4+ was the alternative. Its problems are temporary — the `--experimental-ffi` flag is a no-op from 26.9 and LTS lands 2026-10-28 — except
the permanent ones: a user must install a specific Node, nvm users lose the global on a version switch, and a zero-dependency installer is never
possible. Three of the four peer CLIs (Claude Code, Codex, OpenCode) ship standalone binaries. Bun's costs are one-time build work plus a real, open
Windows crash family managed by pinning; the soak measured it before this ADR.

## Runtime and toolchain

Bun is pinned **exactly** (`packageManager` in `package.json`, `1.4.2` — the release the soak passed on); CI reads the pin. A Bun bump goes through
a pull request that passes the three-OS gate and re-arms the human Windows Terminal check, exactly as ADR 0027 treats an OpenTUI bump. One
toolchain: `bun build --compile` produces the binary, `bun test` runs the suite with `@opentui/solid/preload`, and `Bun.Terminal` drives the
real-terminal suite. `tsup`, `tsx`, the Babel Solid test loader, and the test-only `node-pty` are removed; `tsc`, ESLint, and Prettier stay.
Baseline x64 builds are moot — Bun 1.4 selects AVX2 at runtime.

## Distribution, v1

GitHub release archives cover exactly the three gated targets: Windows x64, macOS arm64, Linux x64. Extra targets are one line each when asked, and
each is a support-matrix row someone will assume is tested. A `curl | sh` shell installer and a PowerShell installer place the binary in a fixed
`~/.secant/bin` on every platform — a location independent of `SECANT_HOME` ([ADR 0023](./0023-own-durable-run-truth-in-isolated-run-stores.md)),
with no override variable, matching OpenCode's fixed `~/.opencode/bin`. An npm launcher `@secantdev/secant` spawns the binary from a per-platform
`optionalDependencies` package with **no postinstall**, so `--ignore-scripts` and pnpm cannot break it; Node of any version is needed only to run
npm and the shim. No Homebrew, winget, scoop, or Docker in v1. No self-updater and no version check in v1.

## Signing, v1

macOS binaries carry Bun's automatic **ad-hoc** signature — Apple silicon refuses arm64 code without at least that — and CI runs
`codesign --verify --deep --strict` on every macOS artefact, because Bun's re-signing has regressed twice (1.3.12, 1.3.13). No Developer ID, no
notarization, and no Windows Authenticode in v1. `curl` does not set the quarantine flag and `tar` does not propagate it, so the curl and npm routes
are never Gatekeeper-evaluated; release-page downloads are documented as "run from Terminal, do not double-click". curl-installed Windows executables
carry no mark-of-the-web, so SmartScreen does not fire on them (Smart App Control machines excepted).

## Storage

The Catalog and Run Store use **`bun:sqlite`** behind their Interfaces. Bun 1.4 implements `node:sqlite`, but its Windows `close()` file-lock bug
hits the Catalog's open-per-command pattern; `bun:sqlite` is Bun's first-class API with a transaction helper. This closes Q8 of the process/runtime
decision: better-sqlite3 is moot under Bun (it needed a Bun fix to load at all and is special-cased by filename).

## Runtime neutrality

[ADR 0018](./0018-adopt-opencode-presentation-as-pinned-reduced-vendor.md)'s runtime-neutrality rule extends from vendored presentation source to
**all target source**, with a named allowlist where `bun:` and `Bun.` are permitted: the SQLite adapter, the Windows console guard, and the CLI entry
check (which needs `Bun.main` to detect the compiled-binary entry, since `import.meta.main` is false in a Bun binary on Windows). The mechanical `Bun.*`
ban in `tests/architecture/check-vendor-provenance.ts` becomes an allowlist instead of a blanket ban. No Node twin implementations exist —
OpenCode's `#sqlite`/`#pty`/`#fff` Node sides serve only its Electron desktop build and are untested. This is achievable: OpenCode touches Bun APIs
in 12 of 833 source files and cut from 321 call sites to 48 by replacing Bun calls with Node builtins.

## Legacy conhost

Legacy conhost is dropped as a support-matrix row. At startup, Secant first suppresses the notice when Windows Terminal's inherited `WT_SESSION`
marker is present, then falls back to `bun:ffi` `GetConsoleWindow` + `IsWindowVisible` to identify a visible, conhost-owned console window. The
marker is supplemental rather than the only discriminator because Windows Terminal documents that it can be absent when configured as the default
terminal host ([microsoft/terminal#13006](https://github.com/microsoft/terminal/issues/13006)). The recorded #66 real-terminal check found that an
ordinary Windows Terminal tab can still expose a visible console window, disproving the original assumption that ConPTY visibility alone was
sufficient. In legacy conhost Secant prints a one-line notice pointing at Windows Terminal; the TUI still runs and headless is unaffected. The wedge is exit-only — a dead console window, no Secant data lost — and OpenCode ships no handling for it with
eight stale-closed bug reports, so the notice is what prevents that noise. The human release check retargets from conhost to **Windows Terminal**,
run when the Bun pin, the OpenTUI pin, or `src/tui/renderer/` changed. The notice can be removed once Bun merges the stdin-release fix
([bun#35621](https://github.com/oven-sh/bun/pull/35621)).

## Fallback condition

The Node 26.4+ npm path — with the transparent `--experimental-ffi` re-exec landed in
[#55](https://github.com/secantdev/secant/issues/55) — is the only fallback, triggered solely if the Windows soak fails on Bun 1.4.2 and again on
the next Bun release. Nothing else triggers it; version churn is handled by the pin. The soak passed on 1.4.2, so this ADR governs.

## Rejected options

- **Node 26.4+ npm package** (the prior choice). Temporary flag pain plus permanent costs: a required specific Node install, nvm global loss on
  version switch, and no zero-dependency installer.
- **`node:sqlite`.** Its Windows `close()` file-lock bug breaks the Catalog's open-per-command pattern.
- **Node twin implementations of the Bun call sites.** Untested surface for no v1 consumer; OpenCode's exist only for its Electron build.
- **Homebrew, winget, or scoop channels in v1.** Homebrew casks must pass Gatekeeper since 2026-09-01, and v1 does no Developer ID signing.

## Future-version ledger

- Developer ID signing + notarization and Windows Authenticode — required before a Homebrew channel or browser-download support.
- `secant upgrade` — must write a new file and rename, never overwrite in place (macOS caches the signature in the kernel; an in-place overwrite
  crashes on next launch until reboot).
- Extra targets (macOS x64, Linux arm64/musl, Windows arm64), Homebrew/winget/scoop, a passive update notice, and dropping the conhost notice once
  Bun fixes stdin release.
