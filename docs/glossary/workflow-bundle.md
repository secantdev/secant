# Workflow Bundle

This cluster defines Crucible's portable workflow package. It fixes what a Bundle may declare, how all Bundle sources enter the local Catalog, and
what integrity and trust mean before execution.

## Terms

- **Bundle identity** — the immutable pair of a Workflow Bundle's lowercase reverse-domain id and strict semantic version. _Avoid_: Digest,
  filename.
- **Bundle digest** — the SHA-256 digest of the exact `.wfb` bytes. It identifies content for integrity and Run pinning, but is not a Bundle's
  domain identity. _Avoid_: Version.
- **Bundle manifest** — the strict JSON document at `manifest.json` in the archive root that declares the Bundle, its compatibility, launch inputs,
  assets, and routing. _Avoid_: Metadata file, configuration file.
- **Installed Bundle** — the exact `.wfb` bytes copied into Crucible's managed store and named by one **Catalog Entry**. Original authoring folders
  and imported files are not Installed Bundles and remain outside Crucible's ownership. _Avoid_: Archive copy, Bundle Snapshot.
- **Bundle origin** — advisory Catalog metadata describing where Crucible obtained an Installed Bundle: an app release (recorded with the Secant
  version that shipped it), local build directory, imported local file, or later a portal coordinate. It is not consulted during execution.
  _Avoid_: Trust, authority.
- **Shipped Bundle** — the exact `.wfb` bytes carried inside a Secant release package beside the CLI. Like an imported file it is not an Installed
  Bundle and stays outside the managed store; Secant reads it only to install it. _Avoid_: Built-in (that is the Installed Bundle), fixture.
- **Built-in Workflow Bundle** — an Installed Bundle whose origin is a Secant release, installed from a **Shipped Bundle** at startup. It inherits
  app-release trust and cannot be removed in v1. _Avoid_: Default Bundle, embedded workflow.
- **Trust grant** — local approval to execute one installed Bundle digest. It persists while that exact Bundle remains installed, has no separate
  revocation path, and says nothing about another digest even when the two Bundles claim the same publisher or id.
- **Execution summary** — Crucible's generated account of the authority an Installed Bundle can exercise on the selected platform, shown before
  the first execution of an untrusted digest. It is derived from the Bundle rather than supplied by its author.

## Package and identity rules

- `.wfb` is a custom extension over a constrained ZIP archive. The archive contains UTF-8 relative paths and regular files only; absolute or
  traversing paths, links, special files, duplicate paths, case-colliding paths, encryption, multipart archives, and compression methods other
  than `store` or `deflate` are invalid.
- The official builder normalizes entry ordering, timestamps, permissions, and manifest encoding. An installer accepts compatible ZIP metadata
  that has the same semantics; reproducible builder output is not an installer prerequisite.
- The package format sets no universal size ceiling. Each Crucible installation applies configurable budgets to input bytes, expanded bytes, and
  entry count, estimates them before extraction, and enforces actual totals while incrementally decompressing. A Bundle cannot raise those limits.
- A Bundle identity is first-install-wins. An incoming Bundle with an installed `(id, version)` is discarded: an equal digest reports "already
  installed," while a different digest reports an identity collision. It never replaces the Catalog Entry.
- Every install calculates and reports the digest, records it in the Catalog, and verifies the managed bytes after storing and before launch or
  resume. The Bundle has no self-digest or mandatory sidecar; a future portal may supply a signed expected digest externally.

## Manifest and composition rules

- V1 accepts JSON only and rejects unknown top-level or nested fields. The top level is `formatVersion`, `bundle`, `requires`, `platforms`,
  `inputs`, `assets`, and `routing`; it has no generic extensions bucket, includes, generators, environment substitution, or remote content.
- `bundle.id`, `bundle.version`, `bundle.name`, and `bundle.description` are required. Authors may also declare authors, license, homepage,
  repository, keywords, and notice-asset paths. Portal ratings, downloads, verification, origin, and trust are never Bundle declarations.
- Authors do not declare `requires.engine`: the builder derives the minimum compatible engine range from every feature used and writes it into the
  packaged manifest. Installation independently rejects a range lower than the manifest actually requires.
- `platforms` is a non-empty subset of `windows`, `macos`, and `linux`. When omitted while authoring, the builder writes its current OS; an authored
  subset is preserved. Installation is platform-independent, while launch preflight rejects a machine outside the declared subset. Built-in and
  Proof Bundles declare all three and prove them in CI.
- All launch inputs are required in v1 and declare a name, one of the five Run Artifact types, and a human description. The five closed types are
  `text`, `file`, `file-set`, `verdict`, and `choice`; their native validation is respectively non-empty text, an existing non-empty file, a
  non-empty set of existing files, `pass` or `fail`, and a member of the declared choices.
- A `file` launch input or produced `file` artifact may additionally name a bundled JSON Schema Draft 2020-12 asset. V1 validates only UTF-8 JSON
  files, allows `$ref` only within that one schema document, validates launch input during preflight, and treats invalid produced output as an
  ordinary failed Step Attempt. Schema composition is checked at install and launch.
- `routing` is an ordered array of Steps and contiguous Repeat groups. Repeat groups cannot nest. A Step declares only author data: a unique id,
  Crucible-owned kind, required and produced artifacts, Harness Session selection when applicable, an optional retry override, and kind-specific
  parameters, plus optional members of Crucible's closed **Workspace prerequisite** set. It never repeats the kind's intrinsic capabilities,
  preconditions, outcomes, reconciliation, or other fixed contract.
- Every Repeat group declares a required `reviewCheckpoint` with a positive-integer `interval` and plain-text `message`. The interval is a review
  cadence rather than a maximum or launch input; Crucible enforces an engine-owned safety ceiling.
- The Composition check also proves that every non-manifest archive entry belongs to exactly one declared asset in non-overlapping asset trees,
  every asset and artifact reference resolves with the right kind or type, every Prompt slot names a required artifact, every schema use is valid,
  and every supported platform resolves one valid command invocation.

## Asset and command rules

- An asset is a `prompt`, `skill`, `schema`, `script`, or `resource`. A prompt is one UTF-8 `.txt` or `.md` file; a skill is a folder with a root
  `SKILL.md` and contained supporting files; a schema is one UTF-8 `.json` file; a script is one UTF-8 text file with any conventional extension;
  and a resource is one opaque regular file or folder tree. Native executable payloads are not scripts in v1.
- Steps distinguish `{"asset":"path"}` from `{"artifact":"name"}`. Only explicitly referenced assets are materialized, in Crucible-owned
  read-only hidden space rather than automatically in the Workspace. Harness Adapters deliver prompts, skills, and resources in Harness-native
  form; commands receive asset paths as structured arguments.
- A command invocation is a static PATH-resolved executable name plus ordered argument tokens, a Workspace-root or safe Workspace-relative working
  directory, and literal or artifact-derived environment additions. Arguments are literals, Run Artifact references, or Bundle Asset references;
  there is no implicit shell interpolation and an executable cannot come from an absolute path, Workspace path, or artifact.
- A Bundle may supply per-platform command parameter overrides, but not Routing branches. Running an explicit PATH interpreter such as `bash`,
  `node`, or `python` with a script asset is valid. Preflight resolves only the selected executable; tools invoked transitively by a script remain
  runtime dependencies whose absence produces ordinary Command results. V1 declares no separate dependency list or executable version constraints.
- Commands run as the current OS user. Crucible promises no command sandbox: commands and Harness actions may access the user's files, environment,
  network, and Workspace within the authority of that user.

## Build, trust, and lifecycle rules

- `bundle build <folder>` validates and normalizes an authoring folder, creates exact `.wfb` bytes, calculates their digest, and atomically installs
  them. `--output` additionally exports those same bytes; `--no-install` skips only the store and Catalog write and requires `--output`.
  `bundle install <file.wfb>` imports a file obtained elsewhere through the identical validator, managed store, and Catalog path. Neither operation
  modifies its input, executes content, loads code, or fetches remote content.
- Built-in Bundles are built once in CI as Shipped Bundles, ship inside the package, and are installed through `bundle install` ingestion at every
  startup when their identity is absent. Their version is authored, independent of the package version, and locked with its digest so a content
  change forces a version bump. Upgrades install the new version beside the old one; see
  [ADR 0029](../adr/0029-ship-built-in-workflow-bundles-as-release-built-wfb-files-installed-at-startup.md).
- Built-in, local-build, local-file, and future portal Bundles share one ingestion and runtime contract. Versions install side by side; interactive
  selection defaults to the highest stable installed version, prereleases require explicit selection, and Crucible never auto-updates.
- External Bundles install untrusted. Before the first attempted Run for a digest, Crucible presents its generated Execution summary and asks once;
  the local Trust grant persists for as long as that exact Bundle remains installed. A new digest asks again. There is no independent trust-
  revocation action or pipeline: a user may decline to launch the Bundle, and removing an External Workflow Bundle also removes its grant. Built-ins
  inherit app-release trust, while future external signatures or attestations may establish provenance and integrity but never safety.
- The summary identifies the Bundle, digest, origin, platforms, Step-kind counts, selected commands, working directories, environment variable
  names, and scripts, and warns that Commands and Harness actions run with the current user's authority and cannot have all their effects predicted
  statically. There is no separate Git-write authority. Trust is checked before a new Run or resume.
- A Run's Bundle Snapshot records the exact Bundle identity and digest without duplicating `.wfb` bytes. For an External Workflow Bundle, normal
  uninstall refuses only while a `running` or `blocked` Run uses that exact Installed Bundle. `halted` and `failed` Runs do not prevent removal;
  their resume fails until the exact digest is reinstalled, and another version or digest never substitutes.
- Successfully uninstalling an External Workflow Bundle removes only Crucible's managed `.wfb`, Catalog Entry, and Trust grant. It preserves the
  original authoring folder or imported file and the Run's history, events, artifacts, identity, version, and digest. Forced uninstall first
  interrupts affected live Runs to `halted` and completes their cleanup; if safe stopping fails, nothing is removed. V1 exposes no removal of
  built-in Bundles; whether a later version permits it remains open.

## Related decisions

- [ADR 0021](../adr/0021-use-immutable-self-contained-workflow-bundles-with-digest-scoped-trust.md) records why packaging, identity, execution
  authority, and local trust form one boundary.
- [Define the self-contained Workflow Bundle contract and trust model](https://github.com/DevFlow-HQ/devflow-cli/issues/9) records the complete v1
  contract and alternatives resolved during grilling.
- [Decide which Git operations Crucible performs for a Workflow and where they sit in the routing](https://github.com/DevFlow-HQ/devflow-cli/issues/14)
  adds authored **Workspace prerequisites** while keeping command-tool dependencies and Git effects outside static Bundle inference.
- [Define built-in Workflow Bundle shipping, installation, and upgrade](https://github.com/DevFlow-HQ/devflow-cli/issues/41) and
  [ADR 0029](../adr/0029-ship-built-in-workflow-bundles-as-release-built-wfb-files-installed-at-startup.md) fix how a **Shipped Bundle** becomes a
  **Built-in Workflow Bundle** and survives upgrades.
