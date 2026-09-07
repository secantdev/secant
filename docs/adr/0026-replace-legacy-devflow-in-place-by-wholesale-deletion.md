# Replace Legacy DevFlow In Place By Wholesale Deletion

Crucible grows inside this repository, and the legacy DevFlow implementation is deleted in one commit at the start of migration rather than
strangled slice by slice, frozen until a first slice lands, or abandoned for a clean repository. The
[migration topology decision](https://github.com/DevFlow-HQ/devflow-cli/issues/18) fixes this because no user or compatibility obligation exists
and every legacy mechanism is contradicted by a settled target decision: PTY control and `node-pty` by the
[runtime decision](https://github.com/DevFlow-HQ/devflow-cli/issues/21), hook sockets and JSONL session-log tailing by structured stdio Harness
transports ([ADR 0022](./0022-own-a-truthful-deep-harness-seam.md)), scoped provider homes by the installed CLI's own authentication boundary,
repo-local `.devflow/` JSONL state by Crucible home with SQLite and per-Run Git ([ADR 0023](./0023-own-durable-run-truth-in-isolated-run-stores.md)),
and the fixed six-stage pipeline by Workflow Bundles over Step kinds ([ADR 0021](./0021-use-immutable-self-contained-workflow-bundles-with-digest-scoped-trust.md)).

## The cut

The cut is the first implementation slice; its position in the sequence belongs to
[the sequencing decision](https://github.com/DevFlow-HQ/devflow-cli/issues/20). It tags the preceding commit `legacy-devflow`, then in one commit:

- Deletes every path in the boundary checker's legacy list, the tests and fixtures that mirror them, `prompts/`, the tracked `.agent/Progress.md`,
  the five legacy glossary clusters with the legacy section of `CONTEXT.md`, the provider integration checklist, ADRs 0001 through 0017, and
  every runtime dependency. ADR numbering keeps its gap so later ADRs and their pinned links stay valid.
- Keeps the toolchain configuration, gate scripts, CI workflow, architecture suite, and temp-dir test helper, realigned to Node 24 in `engines`,
  Node types, the build target, and CI. The `legacyFiles` set and the checker's exemption branch are removed rather than left empty.
- Leaves a stub CLI entry answering `--help` and `--version` so the installed-package smoke passes, renames the package and bin to Secant as
  [ADR 0028](./0028-adopt-secant-as-the-product-package-and-command-name.md) decides (the organization and repository were already renamed to
  `secantdev/secant` on 2026-09-07, before the cut), and replaces the README with an in-development notice. Nothing is published.

## Disposition rule

Legacy code is either reused or deleted; nothing is extracted. Reuse applies only to target-neutral files already under the baseline. Deleted code
is evidence: a slice that needs a similar mechanism reads the file at the `legacy-devflow` tag and writes fresh code against the target
Interface, never copying a legacy file into a target path. No legacy dependency is grandfathered; each library is re-earned by the slice that
needs it under the runtime decision's built-ins-first rule.

Per-Run diagnostics belong to the Run Store Module's private layout and pre-Run process diagnostics to composition wiring. The metadata-only
tracing rule from retired ADR 0011 carries forward: diagnostics record Harness and Adapter metadata, never prompt or message bodies.

## Rejected options

- **In-repo strangler.** Keeping `devflow` runnable while swapping internals needs throwaway translators between the Provider and Harness models
  and keeps 539 Node 20 tests in a gate that must move to Node 24.
- **Freeze, then delete at the first slice.** Same gate cost, and running legacy teaches nothing about transports it does not use.
- **Clean repository.** Breaks every commit-pinned link in the map, ADRs, and research, and discards the working CI, gate, and boundary checker.
- **Extracting the hook socket server.** The only cross-platform legacy IPC code serves a transport the target retires; the permission bridge's
  transport is undecided, and extraction needs a demonstrated consumer.
