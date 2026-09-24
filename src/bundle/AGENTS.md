# bundle — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The digest is taken over the exact archive bytes, so any change to the ZIP writer's layout (entry order, timestamps, permissions, manifest encoding)
  rewrites every digest. A built archive and an imported one are the same Installed Bundle only when their bytes are identical. The Shipped Bundle
  digests are pinned in `bundles/builtin.lock.json`, so such a change, like any authored byte change, needs a manifest version bump and a lock update.
- Build and install validate the manifest in `manifest.ts`, but through two validators over two schemas: `validateManifest`→`authoredManifest` on build,
  `validatePackagedManifest`→`packagedManifest` on install (`requires`/`platforms` differ; nested schemas are shared). Install additionally re-derives
  `requires.engine` to reject an understated range, and runs the same Composition check the build runs over the archived prompt/schema text, so a
  received archive is refused with the build-time finding codes; launch and resume re-run it over the pinned stored bytes (`application.ts`). The
  digest makes a built and an imported archive indistinguishable once stored.
- The Catalog's digest-named asset tree (`<home>/bundles/<digest>/`) is a derived, read-only cache of the managed bytes, never an identity or a second
  source of truth: `readBundleAssets` hands the Catalog the manifest-declared entries (never `manifest.json` or an unclaimed entry), and a missing or
  corrupt tree is re-derived from the bytes. Nothing keys on the tree; the digest over the bytes stays the only content identity.
- Budgets are enforced by the constrained reader over untrusted bytes; Bundle content never relaxes them. A Bundle cannot raise its own input, expanded,
  or entry-count limits.
- The relative-path helper (`relative-path.ts`, D8) accepts or rejects a manifest asset path and an archive entry name identically — but only for that
  shared rule. Each side layers its own checks on top, so full validation is not identical: the manifest also rejects empty/whitespace, the archive also
  rejects a trailing slash, non-UTF-8, and case-fold duplicate names, so `"foo/"` passes the manifest rule and fails the archive rule.
