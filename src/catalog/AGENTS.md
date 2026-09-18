# catalog — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- First-install-wins is decided inside one immediate write transaction (`commitInstall`): a second install of the same identity whose digest already matches
  returns `already-installed`, and an identity collision (same id/version, different digest) returns `identity-collision` changing neither the store nor the
  Entry.
- The installation generation is a private monotonic increment (max + 1 per install), and a Trust grant is keyed on `(digest, installation_generation)`
  (`schema.ts` primary key), so reinstalling identical bytes lands a fresh generation and voids any earlier grant on that digest.
- The asset tree is re-extracted lazily outside the install write lock (`assetRoot`), so two processes launching one digest can both rewrite the same tree;
  each writes identical files, so the loser of the rename simply sees the winner's tree.
- Tree intactness is a size check per declared asset, not a hash (`treeIntact`), so a same-length edit survives until the next reinstall; the managed bytes
  remain the authority either way.
- Extracted asset files are made read-only on POSIX only (`chmod 0o444`); Windows gets no read-only attribute, and directories stay writable on both, so a
  rewrite can `rmSync` the old tree without a chmod pass first.
- The installed asset root (`assetRoot`) is the one storage path that deliberately crosses the Interface — a Run reads the extracted layer from it; every
  other store path (the managed bytes, the tree layout) stays private (ADR 0025).
