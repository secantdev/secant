# Refactoring And Deletion

Read this before replacing or deleting existing behavior or a compatibility layer.

Preserve existing behavior only for an identified current consumer or when it supplies useful evidence. When a change crosses a Seam, name the
invariants, prove the replacement through its Interface, migrate real callers, then delete obsolete implementation, tests, exports, and dependencies.

Compatibility layers require a current consumer. Keep unrelated code outside the change.

New designs use the settled Harness language; a rename of an existing identifier is never assumed to be one-to-one.
