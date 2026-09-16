# Target Module Topology

Read before creating or moving target source, changing public entrypoints, or crossing a Module's Interface. This is the target of
[Define the target Module seams and folder topology](https://github.com/DevFlow-HQ/devflow-cli/issues/27); legacy files are migration evidence.
The [Module design](./module-design.md), [dependency](./dependencies.md), and [testing](./testing.md) standards still apply.

## Ownership

One ESM package contains these ownership areas. Reserve the paths, but create files only when an implementation slice needs their behavior.

| Source area                | Responsibility                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/cli/`                 | CLI hosting and dispatch to the selected client; one executable entry                                          |
| `src/composition/`         | Outermost construction, configuration wiring, and lifecycle wiring                                             |
| `src/application/`         | Projection Port, separate Bundle-management Interface, Preflight, launch, and cross-domain coordination        |
| `src/workflow/`            | Execution-free Routing composition, static Step-kind contracts, and their authored value vocabulary            |
| `src/bundle/`              | Non-executing archive validation/build, Bundle Asset capture, and managed Bundle bytes                         |
| `src/catalog/`             | `catalog.db`, installation lifetime, Trust grants and their Operation receipts, replaceable Run index          |
| `src/drizzle/`             | Generated per-database SQL migrations and the embedded ordered migration journals                              |
| `src/run/execution/`       | Run lifecycle policy, uniform scheduling/retries, and private executable Step kinds                            |
| `src/run/store/`           | Run creation/deletion, Workspace coordination and fencing, `run.db`, canonical records, and atomic publication |
| `src/run/store/artifacts/` | Private Run Artifact capture, Git staging/history, and verified Workspace materialization                      |
| `src/process/`             | Owned child process: PATH-walk executable resolution, Windows shim resolution, direct spawn, tree-reaping kill |
| `src/harness/`             | Crucible's Harness Interface, discovery/qualification, and private native Adapters                             |
| `src/tui/`                 | Crucible presentation plus the reduced OpenCode-derived presentation subset                                    |
| `src/tui/renderer/`        | Renderer Port lifecycle and terminal teardown ordering                                                         |
| `src/headless/`            | Headless client, including Bundle-management commands                                                          |

`cli/main.ts` and `composition/main.ts` name entrypoints, not single-file implementations. A composition root may span cohesive private wiring files
and invoke child composition roots. Only the hosting entrypoint or parent root invokes a root; domain Modules receive dependencies.
Keep command handling, Run policy, Adapter internals, and persistence with their owners. Review growing files for cohesion and split when a named
private submodule improves Locality. There is no numerical source-file limit or requirement to split into one-file-per-helper.

## Interfaces And Imports

The executable [policy table](../../tests/architecture/module-policy.ts) is the exact map of entrypoints and allowed import directions.
Names there are initial choices; move an entrypoint and its policy together when implementation earns a different cohesive file or folder shape.
An `index.ts` is valid for one cohesive Module after declaring it in that table. Multi-Module catch-all and wildcard barrels are excluded.

- Clients receive Application Interfaces; they import `projection-port.ts` and, for headless Bundle management, `bundle-management.ts`.
  `application.ts` is the construction surface for composition, not a client shortcut. Client contracts and their `contracts/` subtree remain
  self-contained; they expose normalized semantic values rather than internal runtime, storage, or Harness objects.
- Application coordinates the domain Modules through their Interfaces. Bundle and Catalog depend only on the static Workflow vocabulary.
  Catalog's Run index is advisory; Application uses Run Store authority for lifecycle decisions.
- Drizzle owns only generated migration assets and their ordered journal Interface. Catalog and Run Store keep their schemas, queries, SQLite
  lifecycle, and migration invocation; only those two owners import the Drizzle entrypoint.
- Run execution uses Workflow, Run Store, Harness, and process Interfaces. Store may reuse normalized Harness evidence types, but owns no Harness
  process. Its private Artifact Module owns Git mechanics. The scheduler dispatches a closed Step-kind table; it never branches on Workflow identity.
- Harness knows no Routing, Step kind, retry budget, or Run policy. Its native Adapters, protocol models, qualification cache, and executable
  discovery remain private. Command executable resolution and the owned child-process spawn/kill live in the `process` Module, shared by Run execution,
  Application (Preflight), and the Harness; the `git-worktree-root` check remains private to Preflight. #14 ruled out a Git Step kind and a Git engine
  Module — Git is ordinary Command-step behaviour plus private mechanics — not a small
  shared helper: the isolated-Git-environment hardening is extracted once, exported from the Run Store entry, and reused by Preflight on repeated use (A31).
- Each Interface owns its exposed types. Import another owner's public contract when the meaning is identical; Application translates facts for
  clients. Extract a small common value only for demonstrated consumers. A central `types/`, `models/`, or utility barrel is not a default owner.
- SQLite belongs to Catalog and Run Store; OpenTUI belongs to presentation/renderer; Harness-native dependencies belong to Harness. Target code
  excludes OpenCode domain imports and PTY transport; Bun APIs (`Bun.*` calls and `bun:` imports) are confined to a named per-API allowlist of four
  target files — the CLI entry (`Bun.main`), the Catalog and Run Store SQLite adapters (`bun:sqlite`), and the Windows console guard (`bun:ffi`), each
  keyed to the one specifier it needs (D6). Renderer drawing may use OpenTUI directly; the Renderer Port covers lifecycle only.

## Enforcement And Tests

[The boundary suite](../../tests/architecture/module-boundaries.test.ts) runs through recursive test discovery in the canonical gate. It resolves the
actual source behind imports using the project's compiler options, including `.js` specifiers targeting TypeScript and configured aliases.
It checks imports of values and types, re-exports, import-type expressions, literal dynamic imports, public entrypoints, and prohibited directions.
Computed imports, custom loaders, source symlinks, and unchecked reference directives need a deliberate rule change rather than a silent bypass.

Tests mirror production domains under `tests/` and cross the same declared Interfaces. A private submodule that earns its own Interface can be
registered as a narrower owner, as the Artifact Module is. Shared Harness conformance coverage and versioned protocol fixtures stay under the
Harness test domain; real resources and opt-in runtime/terminal qualification follow the existing testing baseline.

Target code cannot import legacy or unowned implementation. Only the CLI host invokes outer composition; every other cross-Module reach goes through a
public Interface. The synthetic allowed/forbidden source graphs the suite still carries proved the checker before the target code existed and now guard
it against regression. A green check proves import direction only — not semantic opacity, lifecycle correctness, or file cohesion, which remain
Interface/contract coverage and focused review responsibilities. [ADR 0025](../adr/0025-organize-target-code-around-owned-deep-modules.md) records the
ownership trade-offs and installation/Run lifecycle guarantees.
