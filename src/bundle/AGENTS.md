# bundle — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- The digest is taken over the exact archive bytes, so any change to the ZIP writer's layout (entry order, timestamps, permissions, manifest encoding)
  rewrites every digest. A built archive and an imported one are the same Installed Bundle only when their bytes are identical.
- Build and install run the same manifest validator (`manifest.ts`) over the same shape. Install additionally re-derives `requires.engine` to reject an
  understated range, but skips the Composition check — the digest makes a built and an imported archive indistinguishable once stored.
- Budgets are enforced by the constrained reader over untrusted bytes; Bundle content never relaxes them. A Bundle cannot raise its own input, expanded,
  or entry-count limits.
- The relative-path rule is one shared helper (`relative-path.ts`, D8): a manifest asset path and an archive entry name accept or reject identically.
