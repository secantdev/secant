# Projection Views

This cluster defines the concrete client-facing **Projection** families and view vocabulary M5 added over the **Projection Port**: assessing one
launch draft before a **Run** exists, discovering and qualifying the installed **Harnesses**, and reading a live view's freshness. It owns the
launch-and-catalog read surface; the Run it eventually creates lives in the [Secant Run Lifecycle](./secant-run-lifecycle.md) cluster, and the
generic **Projection**, **Action Offer**, and **Operation** terms live in the [context index](../../CONTEXT.md).

## Terms

- **Launch draft** — the complete, client-owned set of choices that selects a **`launch-preparation`** Projection: **Bundle identity** and version,
  the selected **Harness** id when the routing needs one, an optional **Requested model**, the typed **Launch inputs**, and the trust digest once
  acknowledged. It is the Projection's selector, so changing any field opens a new Projection rather than mutating one, and the family rebases rather
  than preserving identity. A draft is client-owned scratch: it creates no **Run**, **Harness Session**, **Turn**, **Trust grant**, or durable draft.
  _Avoid_: Pending Run, draft Run.
- **`launch-preparation`** — the **Projection** family that assesses one **Launch draft** live and read-only, rerunning the ordered **Preflight**
  checks a launch runs today without creating a **Run**, in that first-fail order: exact **Installed Bundle** still present, **Workspace** approval,
  the pinned bytes still valid and composed, **Interactive agent step** refusal for a client without interactive turns, selected-**Harness** discovery
  and served capabilities, **Launch input** presence and type, **Workspace prerequisites**, **Command step** executables, and **Trust grant**. When the
  draft is otherwise ready and a model is requested, it additionally qualifies only the selected Harness through the bounded qualify path to check the
  **Requested model** against the declared list, then releases it immediately. Its status is `assessing`, `ready`, or `not-ready`; only a `ready` draft
  carries the `launch-run` **Action Offer**, and no status ever creates a Run, Session, Turn, or Trust grant. _Avoid_: Dry-run launch, launch validation.
- **`harness-catalog`** — the **Projection** family for bounded discovery and qualification of the installed **Harnesses**, with an optional exact
  focus on one semantic Harness id. Its `list` view carries one **Harness summary** per registered Harness and spawns nothing; its `focus` view runs
  bounded qualification for that one Harness (prepare then immediate close in composition), caches the result for this process, and adds the
  supported-model declaration, the six **Capability state** rows, the configuration posture, external authentication instructions when the failure is
  authentication, and a diagnostic reference. It projects no **Action Offers**. _Avoid_: Harness registry, harness list.
- **Harness summary** — one row a **`harness-catalog`** `list` view carries for a registered **Harness**: its id and name, its discovery state — found
  with its source, an unsupported shim, or not found with the locations searched — its last **Qualification state**, and the observed executable,
  version, platform, and checked-at evidence when a qualification result is held in this process. It spawns nothing and asserts no capability the
  `focus` view has not qualified. _Avoid_: Harness record, catalog entry.
- **Qualification state** — how far one **Harness** has been qualified in this process, one of `qualified` (every **Capability state** is `available`),
  `qualified-with-limits` (qualification succeeded but at least one capability is limited or unavailable), `not-ready` (qualification failed), or
  `not-checked` (not yet qualified this process). A **`harness-catalog`** `list` open spawns nothing and qualifies no Harness, so one never qualified
  this process reads `not-checked`; a `focus` open qualifies that one Harness, and a result already held this process shows through the `list` view too.
  _Avoid_: Installed, ready.
- **Capability state** — the truthful exposure of one normalized **Harness** capability, one of `available`, `available-with-limits`, `unavailable`, or
  `not-checked`, carrying optional limits text when limited. A focused Harness reports six fixed capabilities — Session recovery, Same-Turn steering,
  Turn interruption, Tool approvals, Structured questions, and Effective model — each mapped from the Harness profile's evidence-bearing fields; an
  unqualified or failed Harness reports all six `not-checked`. _Avoid_: Feature flag, supported.
- **Correction target** — the one **Launch draft** field a **`launch-preparation`** finding or a launch refusal routes correction to, one of `bundle`,
  `harness`, `model`, `inputs`, `trust`, `workspace`, or `command`. Every finding and every launch refusal carries one, so both clients move to the
  step that owns the named field without classifying failure codes or reading free-form detail. _Avoid_: Error code, field name.
- **View freshness** — the health of a followed **Projection**'s update stream, shown as a token kept separate from and never conflated with **Run**
  state: `View current` at the live edge, `View loading` while a closed view reopens, `View catching up` while durable catch-up runs toward the live
  edge, and `View disconnected` when the stream closed from observer lag, subject loss, or shutdown, recording the last-confirmed time. A view is stale
  whenever its freshness is not `current`; controls that dispatch **Operations** are unavailable while a view is stale, and reconnecting is a read, like
  navigation, not an Operation. Freshness is derived from update-stream health rather than scroll position, so a lost stream reads as lost and a stale
  view can never masquerade as a live Run. _Avoid_: `(live)` badge, live indicator.

## Related decisions

- [Secant Run Lifecycle](./secant-run-lifecycle.md) owns the **Run** a ready draft creates, and defines **Requested model** and **Effective model**,
  the pair a `launch-preparation` draft and the Run Workbench both surface.
- [Workflow Bundle](./workflow-bundle.md) owns **Bundle identity**, **Trust grant**, and the **Installed Bundle** bytes a `launch-preparation` draft
  re-checks.
- [ADR 0024](../adr/0024-use-one-deep-projection-port-for-tui-and-headless-clients.md) owns the one deep **Projection Port** these families and views
  cross, shared by the TUI and headless clients.
- [ADR 0022](../adr/0022-own-a-truthful-deep-harness-seam.md) owns the truthful **Harness** Seam whose evidence the `harness-catalog` **Capability
  state** rows and the supported-model declaration project.
- [Spec: M5 — TUI completion](https://github.com/secantdev/secant/issues/180) defines the two Projection families, the Review step, and the Run
  Workbench freshness these terms name.
