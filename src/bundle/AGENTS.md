# bundle — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The digest is taken over the exact archive bytes, so any change to the ZIP writer's layout (entry order, timestamps, permissions, manifest encoding)
  rewrites every digest. A built archive and an imported one are the same Installed Bundle only when their bytes are identical.
- Build and install validate the manifest in `manifest.ts`, but through two validators over two schemas: `validateManifest`→`authoredManifest` on build,
  `validatePackagedManifest`→`packagedManifest` on install (`requires`/`platforms` differ; nested schemas are shared). Install additionally re-derives
  `requires.engine` to reject an understated range, and skips the Composition check — but launch and resume re-run it over the pinned stored bytes
  (`application.ts:628`), so the "install skips it" note is not universal; the digest makes a built and an imported archive indistinguishable once stored.
- Budgets are enforced by the constrained reader over untrusted bytes; Bundle content never relaxes them. A Bundle cannot raise its own input, expanded,
  or entry-count limits.
- The relative-path helper (`relative-path.ts`, D8) accepts or rejects a manifest asset path and an archive entry name identically — but only for that
  shared rule. Each side layers its own checks on top, so full validation is not identical: the manifest also rejects empty/whitespace, the archive also
  rejects a trailing slash, non-UTF-8, and case-fold duplicate names, so `"foo/"` passes the manifest rule and fails the archive rule.
