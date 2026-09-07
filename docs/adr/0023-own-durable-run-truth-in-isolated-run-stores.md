# Own Durable Run Truth in Isolated Run Stores

Crucible persists a **Run** as a transactional record graph rather than a fully event-sourced log: immutable evidence records explain what happened,
while small mutable heads identify current state and Artifact bindings. Acknowledged operations are durably admitted before external effects, current
Run state and its immutable transition are recorded together, settled Turn results never change, and later recovery, reconciliation, checkpoint, or
cleanup evidence appends instead. Startup recovery reconstructs and reconciles but starts no external Step work; explicit human resume acquires fresh
ownership and the Workspace claim before authorizing more work. Native Harness conversation ids remain advisory recovery coordinates, genuine pending
Human Gates remain durable Workflow state, and expired Harness Requests or ordinary assistant questions are never recreated on the Harness's behalf.

Physical persistence follows the same ownership. Runs sharing one resolved absolute **Workspace** value are organized beneath a readable
`<path-slug>--<short-path-digest>` directory. Its `coordination.db` owns only facts shared by those Runs: Run registration, the one-live-Run Workspace
claim, **Run owner** fencing, and create/resume/delete operation admission. Each Run owns one **Run Store** with `run.db` for structured truth, a
private bare Git repository for immutable Artifact content and history, temporary creation/publication/deletion staging, and separately retained
diagnostics. A global Run index is a replaceable projection, not authority. Workspace is still a path value rather than an entity; the grouping and
coordinator are storage organization and coordination, not a new domain identity.

A producer writes **Candidate output** once. Crucible validates every required output of the Step Attempt, captures portable regular-file content,
and stages one Git commit for the complete publication set. The opaque commit id is the Artifact version id; Crucible owns no version counter. A
single `run.db` transaction then publishes every version, moves every affected binding, settles the Attempt, and advances the Run. Only that database
transaction creates the **Artifact publication**; a Git object or staging ref alone is invisible candidate storage. Promotion after the transaction
is recoverable housekeeping. The repository belongs only to that Run, never uses the Workspace's Git repository or shared Git alternates, and is
deleted with the Run. This internal storage use does not reintroduce the Git Step kind, Workspace observation, or public Git Module rejected for
Workflow execution.

Every published Artifact version is canonical inside its Run Store. An authored `home: workspace` declaration requests a **Workspace
materialization**, not a second source of truth. Before use, Crucible verifies that copy against the bound version. A missing or changed copy creates a
**Materialization conflict**: Crucible preserves both sides and halts without silently overwriting the Workspace or adopting its bytes. If a Workspace
write succeeds but validation or publication fails, the file remains external Workspace state and no binding moves. Bundle Assets stay static Bundle
content and never enter this history. Bundle archive validation and Run Artifact capture own separate policies even where their v1 regular-file rules
match, so either can evolve without coupling the other.

Run creation and deletion use admitted, idempotent operations plus temporary `.creating` and `.deleting` quarantine directories; their per-operation
contents disappear after success or startup cleanup. Run-owned canonical state, transcripts, gates, events, and Artifact versions remain until
explicit Run deletion. Minimal failure evidence remains with the Attempt, while detailed diagnostics expire after 90 days by default and reproducible
caches may be collected. If `coordination.db` is corrupt, Crucible ensures no process uses that Workspace grouping, removes the corrupt coordinator and
temporary creation/deletion contents, and performs only a bare-bones rebuild from readable normal Run Stores with no owner or claim; other Workspace
groupings continue. A damaged `run.db` or Artifact repository isolates only that Run. Storage failure after an admitted external effect yields an
Indeterminate attempt when no immutable result can be recorded.

This design deliberately rejects one Git repository for all Crucible state, a Git repository per Workspace, a Crucible-maintained version sequence,
Workspace-only canonical Artifacts, Agent-maintained duplicate copies, automatic coordinator forensics, and full event sourcing. Per-Run repositories
sacrifice cross-Run byte deduplication and create more small stores, but make deletion, corruption isolation, maintenance, and ownership local. The
durability promise covers process, OS, and power failure while the local storage survives; disk loss, manual store deletion, and remote backup are not
part of it. Canonical Run content remains exact even when sensitive, protected by filesystem permissions or future transparent encryption rather than
truth-altering redaction. This decision resolves [Define durable Run truth, outputs, Artifacts, transcripts, and recovery](https://github.com/DevFlow-HQ/devflow-cli/issues/16).

## Amendment (2026-09-07): home directory

The global store tree lives at `~/.secant` on every platform (`%USERPROFILE%\.secant` on Windows), overridable with the `SECANT_HOME` environment
variable. Platform-specific data directories (XDG, `Application Support`, `%LOCALAPPDATA%`) were rejected as three code paths for no user benefit;
the initial Harnesses use the same dotfile convention. Recorded while
[approving the migration handoff](https://github.com/DevFlow-HQ/devflow-cli/issues/22).
