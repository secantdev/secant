# composition — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Cross-Module ownership and import direction are the policy table's.

## Invariants

- Application receives only normalized Harness registrations and never an Adapter object. `HarnessRegistry` is imported only inside composition, where it
  resolves the selected Harness id to the private Adapter before Run execution.
- A registration's catalog qualification prepares its private Adapter against the canonical launch Workspace and immediately closes it. Only a clean close publishes
  the captured profile; prepare or cleanup failure crosses as normalized unavailability, never an Adapter or prepared Harness (#188).
