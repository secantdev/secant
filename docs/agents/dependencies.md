# Dependency Discipline

Read this before changing dependencies, composition, or allowed import direction.

- Modules receive external dependencies through composition rather than constructing hidden dependencies.
- A composition root is an outermost wiring Module. Production Modules never import it; only a hosting entrypoint or parent composition root invokes it.
- Keep wiring and configuration in composition roots and domain policy in its owning Module.
- Callers depend on the narrow Interface they need. Adapter-specific types, configuration, lifecycle, and external models remain behind their Seam.
- Give every third-party dependency a current purpose, and pin native or compatibility-sensitive dependencies deliberately.
- The dependency policy, [§7 of the runtime decision](https://github.com/secantdev/secant/issues/21#issuecomment-5497308855): builtin first, a trusted
  library whenever it makes the code simpler, never rebuild commodity functionality, and only a native dependency needs a prior issue decision.
- **Growth rule.** Hand-roll only what is frozen. If the hand-rolled surface must grow whenever the product grows, take the builtin or library now,
  while the rewrite is small. If the spec is fixed by an external standard and reproducibility or security depends on controlling the bytes, hand-roll
  and say so in a comment. There is no size threshold; applying the rule takes an informed guess about whether the surface grows.
- Every milestone re-judges the whole of `src/` against both rules in the [Milestone audit](./milestone-audit.md).
- Before adding a package, or hand-rolling what a package provides, check how OpenCode decides the same question: its dependency list, where it prefers
  Node built-ins such as `node:fs` over a library, and where it prefers a library such as `fs-extra` over a built-in. Take that evaluation seriously; the
  codebase is maintained by industry-grade engineers and is rarely wrong. Ask the user for the local OpenCode checkout path whenever you need to look, and
  never guess it.

Before creating target source, moving a public entrypoint, or crossing a target Module, read [target topology](./topology.md) for ownership and the
checked import map. Enforce settled, expensive-to-violate directions with the narrowest honest mechanism rather than a general architecture linter.
