# Ship Built-In Workflow Bundles As Release-Built `.wfb` Files Installed At Startup

A **Built-in Workflow Bundle** reaches a user's Catalog through the same non-executing ingestion as every other Bundle; what differs is only where
the bytes come from and when they are offered. The [built-in shipping decision](https://github.com/DevFlow-HQ/devflow-cli/issues/41) fixes this
for the one v1 built-in, the Matt Bundle promoted at the final migration milestone, and for any later built-in.

## Shipping

The release build produces the exact `.wfb` for each built-in on CI and places it inside the npm package as a **Shipped Bundle**. The `build` script
runs the TypeScript bundler first, because it deletes `dist/` before writing, then a small script that builds every allow-listed folder under
`bundles/` with `bundle build <folder> --no-install --output dist/builtin/<id>-<version>.wfb`. `package.json` `files` lists only `dist`, so nothing
under `bundles/` can enter the tarball and the Proof Bundle stays out by construction. The allow-list is a constant in that build script, so a
reviewer sees any change in the diff and no code in `src/` branches on Bundle identity. `--no-install` runs the full validator, normalizer, and
Composition check and skips only the store and Catalog write; it requires `--output`, because a build that neither installs nor writes a file does
nothing. Shipping the authoring folder and building on the user's machine was rejected because it would compute the digest on every machine
instead of once in CI.

## Versioning

A built-in's SemVer is authored in its manifest and is independent of the package version. Stamping it with the package version was rejected
because every release would then add a new Catalog Entry even when the bytes were unchanged, and v1 exposes no built-in removal. Instead a committed
`bundles/builtin.lock.json` records `(id, version, digest)` for each Shipped Bundle, and the canonical gate rebuilds the `.wfb` and fails when the
digest differs from the locked one for the same version. A content change therefore forces a version bump in the same pull request, and a release
can never carry same-identity-different-bytes. The digest must match on all three CI operating systems, so the repository carries a
`.gitattributes` that fixes line endings to LF; the builder never rewrites authored content to compensate. The release approval summary prints each
Shipped Bundle's identity and digest next to the package digest. Maintainers iterate on a built-in under a prerelease version so a local build never
shares an identity with a release.

## Installation

At every startup, in the TUI and headless alike, Composition wires an Application use case that ensures every Shipped Bundle is installed. For
each `.wfb` beside the CLI's own `dist/`, it asks Catalog whether the `(id, version)` is installed; when it is not, it runs the ordinary
`bundle install` ingestion with **Bundle origin** `{ kind: "built-in", secantVersion }`; an equal digest is a no-op and a different digest is the
ordinary identity collision. The checks run concurrently with a plain `Promise.all` and no worker pool, since v1 ships one built-in and every
install commits through one `catalog.db`. A failed ensure never blocks startup: Secant starts, shows a notice naming the cause and remedy, and
every other Bundle remains usable. When no shipped directory exists, as under `tsx` in development, there are zero Shipped Bundles and nothing is
reported. An npm `postinstall` hook was rejected because it runs at install time, often as a different user, and has no per-user home; lazy
installation on first use was rejected because a fresh headless machine would then need the same check anyway.

## Upgrade and coexistence

Upgrading Secant installs the newly shipped version beside the earlier one. The earlier built-in keeps its origin and its release trust, stays
selectable, and remains the pin of any resting Run. Interactive selection defaults to the highest stable installed version. After a Secant downgrade
the newer built-in stays installed but its builder-derived engine range makes Preflight reject a launch with a precise message. No built-in-only
behaviour such as hiding older versions exists, because that would open a second path. The read-only Bundle catalog shows one row per Installed
Bundle, sorted by name then version descending, with the origin as "Built-in, shipped with Secant x.y.z", a marker on the version shipped by the
running Secant, and a "needs Secant ≥ x.y" note on a version the running engine cannot launch.

A user who imports a file whose identity equals an installed built-in gets the plain "already installed" result when the digest is equal. When the
digest differs, the identity-collision error names that the installed Bundle is a built-in and cannot be removed in this version, because the usual
remedy of uninstalling the other Bundle does not exist for built-ins.

## Verification

The package smoke asserts from the installed tarball that it contains exactly the expected `dist/builtin/*.wfb` set and no `bundles/` path, that a
first launch against a fresh `SECANT_HOME` leaves a Catalog Entry for each built-in with origin `built-in` and the locked digest, and that a second
launch changes nothing.

## Amendment — built-ins embedded in the binary (2026-09-10, ADR 0030)

[ADR 0030](./0030-ship-the-shell-as-a-bun-compiled-single-file-executable.md), taken after the
[#60](https://github.com/secantdev/secant/issues/60#issuecomment-5623212589) Windows soak passed, changes only where the built-in bytes live: each
built-in `.wfb` is **embedded in the compiled binary as an asset** and installed at startup **from the embedded bytes**, replacing the "beside the
CLI's own `dist/`" npm-tarball placement; the tarball assertion above becomes the compiled-binary smoke. Versioning (`bundles/builtin.lock.json`, the
gate's digest rebuild, the LF `.gitattributes`), the startup ensure semantics, and upgrade/coexistence are unchanged. Where this ADR and ADR 0030 differ,
ADR 0030 governs.

The **Shipping** section above is **not** unchanged. ADR 0030 replaced the whole packaging toolchain it describes: the TypeScript bundler that deletes
`dist/` before writing, the npm package whose `package.json` `files` lists only `dist`, and the release tarball are all gone, superseded by a Bun
single-file executable compiled by [`scripts/build.ts`](../../scripts/build.ts). What survives is only the per-built-in `.wfb` build step
(`bundle build --no-install --output`) and its allow-list; the built-in bytes are then embedded as binary assets, never placed in a tarball. (Edited 2026-09-24: M6 implemented
built-in shipping from ADR 0030's compiled-binary toolchain, not the stale Shipping text above: the Matt Bundle is locked and embedded as the sole
Shipped Bundle ([#226](https://github.com/secantdev/secant/issues/226)) and installed at startup from those embedded bytes
([#227](https://github.com/secantdev/secant/issues/227)).)
