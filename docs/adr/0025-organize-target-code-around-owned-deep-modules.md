# Organize Target Code Around Owned Deep Modules

Crucible keeps one package, with distinct Workflow, Bundle, Catalog, Run execution, Run Store, Harness, Application, and presentation ownership.
The [topology decision](https://github.com/DevFlow-HQ/devflow-cli/issues/27) resolves these seams before migration so legacy file boundaries cannot
silently become the new domain model. [Target topology guidance](../agents/topology.md) routes implementation to the exact checked import map.

Static Step-kind definitions and composition live in an execution-free Workflow Module, shared by Bundle validation and Run execution. Executable
Step kinds stay private to Run execution and use one closed dispatch table. This gives a new kind a known addition point while keeping Bundle
installation non-executing. Run execution decides legal transitions; Run Store accepts semantic operations and enforces expected state, fencing,
and the atomic publication/Attempt/binding/advancement guarantees of [ADR 0023](./0023-own-durable-run-truth-in-isolated-run-stores.md).
Run Artifact capture remains a separate private Module from Bundle capture even when their portable-file rules coincide.

Application owns cross-domain use cases, including Preflight, launch, and forced Bundle removal. Its Projection Port and separate Bundle-management
Interface keep clients small. Catalog owns the shared catalog database, installation records, Trust grants and durable trust-operation receipts,
and the replaceable Run index; the Run Store Module owns authoritative Workspace coordination and isolated per-Run storage. Physical database
ownership is explicit so no two domain Modules coordinate by reaching into each other's rows.

Catalog guards the lifetime of each installation across processes. Removal excludes new use for launch/resume and waits for authoritative Run
checks and safe cleanup before managed bytes disappear; a discovery cache cannot establish safety. Application coordinates Catalog, Bundle bytes,
and Run authority without cyclic domain imports. Failure leaves the installation intact, although already-stopped Runs may remain halted.
An internal installation generation distinguishes uninstall/reinstall of identical bytes: stale trust offers and old operation receipts never
grant authority to the replacement installation. Trust changes and their applied outcomes share Catalog's atomic boundary. Run Snapshots still pin
Bundle identity and digest; the generation is private coordination evidence, not a new public domain identity or substitute for the digest.
Uninstall removes the grant but retains the minimal Operation receipt or tombstone needed to return the original result on replay.

The v1 process architecture has no remote control channel. A live Run owned by another process makes forced removal unavailable until it is stopped
there. Catalog use/removal exclusion must survive concurrent invocations and recover conservatively after crashes; stale holders cannot authorize
work, and expiry alone cannot prove a Run or its native work has stopped. The exact lock/record mechanism belongs to implementation and must uphold
these Interface guarantees. Preflight owns a prepared Harness until successful Run handoff; one owner remains responsible for cleanup on every
failure path. Durable creation followed by failed handoff leaves recoverable, non-advancing Run state, never orphaned external execution.

The outer composition root constructs and connects dependencies; it may delegate to cohesive private wiring files and child roots. One logical
root does not prescribe one large file. Source growth triggers cohesion review, while numerical caps and one-file-per-helper splitting would
scatter lifecycle ordering. Named entrypoints and cohesive `index.ts` files both work; deliberately exported Interfaces, private implementation,
Interface-owned types, and checked import directions provide the encapsulation. Tests mirror domains and use those same Interfaces.

We rejected copying OpenCode's package count, a shared model/utility barrel, generic row/transaction callbacks exposed to execution, distributed
construction in clients, and target-to-legacy shortcuts. The cost is explicit translation and a maintained small import policy; the benefit is
local reasoning about ownership and failure without making each caller learn storage, protocol, or renderer mechanisms. Runtime dependencies and
the production source tree remain unchanged by this planning resolution; enforcement tooling establishes the agreed ratchet before migration.
