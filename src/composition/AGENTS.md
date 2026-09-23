# composition — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Cross-Module ownership and import direction are the policy table's.

## Invariants

- Application receives only normalized Harness registrations and never an Adapter object. `HarnessRegistry` is imported only inside composition, where it
  resolves the selected Harness id to the private Adapter before Run execution.
- Composition constructs the one real Process implementation (`createProcessAdapter`) and injects that instance into Run execution, the Run Store,
  Application's Preflight, and the Harness registry; tests replace it through the wiring overrides, never by a second construction site.
- Composition owns the qualify prepare-then-close pairing: a registration's catalog qualification prepares its private Adapter against the canonical
  launch Workspace and immediately closes it. Only a clean close publishes the captured profile; prepare or cleanup failure crosses as normalized
  unavailability, never an Adapter or prepared Harness (#188).
