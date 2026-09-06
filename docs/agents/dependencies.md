# Dependency Discipline

Read this before changing dependencies, composition, or allowed import direction.

- Modules receive external dependencies through composition rather than constructing hidden dependencies.
- A composition root is an outermost wiring Module. Production Modules never import it; only a hosting entrypoint or parent composition root invokes it.
- Keep wiring and configuration in composition roots and domain policy in its owning Module.
- Callers depend on the narrow Interface they need. Adapter-specific types, configuration, lifecycle, and external models remain behind their Seam.
- Give every third-party dependency a current purpose, and pin native or compatibility-sensitive dependencies deliberately.

Before creating target source, moving a public entrypoint, or crossing a target Module, read [target topology](./topology.md) for ownership and the
checked import map. Enforce settled, expensive-to-violate directions with the narrowest honest mechanism rather than a general architecture linter.
