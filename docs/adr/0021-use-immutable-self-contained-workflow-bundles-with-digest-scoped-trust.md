# Use Immutable Self-Contained Workflow Bundles With Digest-Scoped Local Trust

A Crucible **Workflow Bundle** is one self-contained `.wfb` file: a constrained ZIP with a strict root `manifest.json`, every prompt, skill, schema,
script, and resource needed to run, and no runtime dependency on its authoring directory or a remote content URL. Built-in, locally built, imported,
and future portal Bundles all pass through the same non-executing validator, managed store, Catalog, and runtime. A local build combines packaging and
atomic installation, while import exists for an already-built `.wfb`; both preserve their inputs. We chose JSON alone for v1 because one strict data
model and mature schema tooling keep validation and canonical packaging unambiguous, while human-friendly YAML authoring can later compile to the
same packaged manifest without changing the runtime contract.

The immutable domain identity is `(bundle id, semantic version)`, while SHA-256 over the exact `.wfb` bytes is its integrity and content identity.
First install wins: a repeat identity is discarded whether its bytes match or collide, so publishing different content under an existing version can
never silently rewrite a machine's Catalog. The builder normalizes archive bytes for reproducibility, derives the minimum compatible engine range,
and inserts a declared or build-host platform set; the installer independently verifies semantics and compatibility. The format has no universal
size ceiling, but every consumer protects itself with locally configurable compressed-byte, expanded-byte, and entry-count budgets that Bundle
content cannot relax.

The manifest declares only workflow-authored data. Routing selects Crucible-owned Step kinds and supplies their artifact flow, Harness Session,
retry override, kind-specific parameters, and optional members of Crucible's closed **Workspace prerequisite** set rather than copying each kind's
fixed capabilities or outcome rules into every Step. Static Bundle Assets and dynamic Run Artifacts are deliberately separate and explicitly
referenced. Commands are structured PATH-resolved executable names, argument tokens, safe Workspace working directories, and environment additions;
there is no implicit shell or executable path derived from a Bundle, Workspace, or artifact. Preflight resolves the direct executable, while tools a
script invokes transitively remain opaque runtime dependencies. This prevents accidental string interpolation and package-time execution, but it is
not a sandbox: launched commands and Harnesses retain the current OS user's authority.

Trust therefore lives outside the Bundle and is scoped to its digest. Crucible generates an **Execution summary** from the manifest for the selected
platform and asks once before the first external execution; the local grant persists while that exact Bundle remains installed, and any new digest
asks again. There is no separate trust-revocation action or pipeline: a user may decline to launch an unwanted Bundle, and uninstalling an External
Workflow Bundle removes both it and its grant. Built-ins inherit the trust of the installed app release. A future portal signature may attest who
supplied exact bytes, never that executing them is safe. Trust is checked before Run creation and resume.

A later refinement, [Decide which Git operations Crucible performs for a Workflow and where they sit in the routing](https://github.com/DevFlow-HQ/devflow-cli/issues/14),
removed the provisional Git Step family and any separate Git-write authority. Git reads and mutations use ordinary Commands or Harness behaviour;
the only Crucible-owned Git behaviour is the private probe implementing the authored `git-worktree-root` Workspace prerequisite. This keeps the
manifest honest about what it can know: it exposes direct commands and scripts but does not claim to infer their transitive tools or effects.

Managed Bundle bytes include a derived, read-only extracted asset tree named by the same digest, created and removed with the bytes, never an
identity or a second source of truth. A Run records its Bundle identity and digest as a **Bundle Snapshot**, not another permanent copy of the
archive. For an External Workflow Bundle, normal uninstall is refused only while a live (`running` or `blocked`) Run uses that exact Installed
Bundle; resting (`halted` or `failed`) Runs do not retain it. Removal deletes only Crucible's managed bytes, Catalog Entry, and Trust grant,
preserving external inputs and Run history. Such a resting Run can resume after the exact digest is reinstalled, while another version or colliding
digest never substitutes. Forced removal must first interrupt and clean up live Runs or leave the Bundle untouched. V1 exposes no removal of built-in
Bundles; whether a later version permits it remains open.
