# DevFlow — Context

DevFlow is a provider-agnostic meta-orchestrator that delegates to AI coding CLIs. Crucible is its target Harness-oriented model.

## Glossary

This index and its linked glossary clusters are the canonical domain vocabulary. Each term has one definition. Read this index, then only the
cluster that matches the task, followed by its related ADRs when the task needs policy or rationale.

### Target language

- **Workspace** — the resolved absolute directory a **Run** executes against, taken from the directory where Crucible was launched. It is a value
  on the Run, not an entity with its own identity. _Avoid_: Project.
- **Run** — one execution of one **Workflow Bundle** against one **Workspace** through one **Harness**. See the
  [Crucible Run lifecycle](./docs/glossary/crucible-run-lifecycle.md) cluster for everything inside a Run.
- **Catalog Entry** — the local record that one exact **Workflow Bundle** identity and digest is installed, plus its advisory **Bundle origin**.
  Installing creates one; uninstalling removes it with Crucible's managed Bundle bytes.
- **Workflow Bundle** — one self-contained `.wfb` workflow file: a constrained ZIP archive whose root `manifest.json` declares its workflow and
  every **Bundle Asset** it carries. Built-in and **External Workflow Bundles** use the same package and execution contract.
- **External Workflow Bundle** — a **Workflow Bundle** supplied outside Crucible's built-in set. It follows the same package and execution
  contract as a built-in Workflow Bundle.
- **Built-in Workflow Bundle** — a **Workflow Bundle** installed at startup from the copy shipped inside the Secant package. See the
  [Workflow Bundle](./docs/glossary/workflow-bundle.md) cluster for **Shipped Bundle** and the built-in rules.
- **Routing** — the ordered arrangement of **Steps** a **Workflow Bundle** declares over Crucible's **step kinds**, with contiguous spans optionally
  declared as **Repeat groups**. Strictly sequential: no branching, no parallelism, and no nested groups. A Bundle is runnable when its routing
  composes — see **Composition check** in the [Crucible Run lifecycle](./docs/glossary/crucible-run-lifecycle.md) cluster.
- **Step kind** — one of Crucible's four built-in **Step** contracts: **Agent step**, **Interactive agent step**, **Human Gate**, or **Command step**.
  All satisfy one uniform Interface: what the kind intrinsically requires, what it produces, which **Harness Session** it needs, its intrinsic
  preconditions, its capability needs, which attempt outcomes it may retry, and how an **Indeterminate attempt** is reconciled. Crucible owns the
  set; a **Workflow Bundle** supplies content, parameters, and optional **Workspace prerequisites**, never its own step implementation.
- **Workspace prerequisite** — one of Crucible's closed semantic facts about a **Workspace** that an authored **Step** may require and **Preflight**
  checks before creating a **Run**. V1 has one: `git-worktree-root`, meaning Git is runnable and the Workspace is exactly the root of a non-bare Git
  worktree; linked and unborn worktrees qualify. It is not an inventory of executables a script or **Harness** might invoke.
- **Prompt slot** — an artifact placeholder of the form `{{artifact:name}}` in a **Workflow Bundle** prompt, filled from the **Run**'s bindings.
  It is substitution only, with no conditionals, loops, includes, or expressions; a **Harness Adapter** renders a `file` artifact natively.
- **Bundle Asset** — static, read-only content carried inside a **Workflow Bundle**, identified by its relative path and declared kind. It has no
  producer, no per-attempt version, and no place in a Run's bindings; a **Harness Adapter** decides how referenced assets reach its Harness.
- **Proof Bundle** — the role held by a maintained **External Workflow Bundle** whose purpose is to keep Crucible's step vocabulary honest. It
  lives outside the source tree, loads the way a user's own Bundle would, and is exercised in CI. It is not shipped in the catalog. The role
  survives any particular occupant.
- **Test Repair Workflow** — the first **Proof Bundle**. Given a path to a failing test, it drives that test to green through bounded **Step
  Attempts**, instructs its fixing Agent not to commit, then routes an ordinary **Command step** to commit after a **Human Gate** approves. The
  ordering is a Bundle contract, not a Git invariant Crucible enforces around the **Harness**.
- **Harness** — an external coding-agent runtime Crucible can select for workflow execution. Codex, Claude Code, and Gemini are the initial
  Harnesses; their capabilities need not be identical.
- **Harness Adapter** — an Adapter at the Harness Seam that contains Harness-native control, event, and failure semantics behind a
  Crucible-owned Interface.
- **Projection Port** — the single Crucible-owned application Interface shared by TUI and headless callers. It opens bounded **Projections**,
  admits user intent as **Operations**, and reads content through **Resource References** without exposing workflow-runtime, persistence, Adapter,
  or Harness-native objects. It is an in-memory Interface rather than a wire protocol; see [ADR 0024](./docs/adr/0024-use-one-deep-projection-port-for-tui-and-headless-clients.md).
- **Projection** — a disposable bounded task view over canonical Crucible truth, optionally combined with an explicitly separate live Harness
  overlay. It carries current **Action Offers** and can be rebuilt without preserving cache, database, or storage identity. _Avoid_: Entity mirror,
  screen model.
- **Action Offer** — a typed, state-bound opportunity projected for one exact semantic target, including the input it accepts and evidence when it
  is unavailable. It tells a client what may be submitted now without making projection presence itself authoritative. _Avoid_: Generic command,
  capability flag.
- **Operation** — Crucible's durable admission and application/control result for one user intent, correlated by a caller-generated id. It does
  not imply that arbitrary Command or Harness effects execute exactly once or that the resulting Run work has completed. _Avoid_: Step Attempt,
  Harness Turn.
- **Resource Reference** — an opaque typed reference to bounded history, immutable or retained content, a file-set manifest, or an export readable
  through the Projection Port. It never exposes internal storage identity or a Harness-native recovery coordinate. _Avoid_: File path, database id.
- **Renderer Port** — the Crucible-owned Interface around the terminal renderer, covering lifecycle only: size, key input, resize, and teardown.
  It exists so the whole shell lifecycle is exercisable against a fake with no terminal, and it carries the teardown ordering the legacy Windows
  console host requires. See [ADR 0018](./docs/adr/0018-adopt-opencode-presentation-as-pinned-reduced-vendor.md).

### Target Crucible clusters

- [Workflow Bundle](./docs/glossary/workflow-bundle.md) — Bundle identity, packaging, manifests, assets, installation, trust, and removal.
- [Crucible Run lifecycle](./docs/glossary/crucible-run-lifecycle.md) — Runs, Steps, Step Attempts, Turns, Run Artifacts, Harness Sessions, Human
  Gates, Harness Requests, and the Run states.

### Legacy Provider language

These terms describe the current DevFlow model, not Crucible's target Harness model.

- **Provider** — DevFlow's legacy selection and fallback-wiring concept around an AI coding CLI, not a synonym for the target **Harness**.
- **Supported provider** — a selectable legacy **Provider** with a structured data plane that can satisfy the normalized provider-event contract.
- **Deferred provider** — a wired legacy **Provider** intentionally excluded from selection. The current selection policy and initial sets belong
  to [ADR 0012](./docs/adr/0012-defer-gemini-and-opencode-as-wired-but-unselectable-providers.md).

### Legacy DevFlow clusters

- [Provider session control](./docs/glossary/provider-session-control.md) — launch, terminal control, cleanup, scoped state, and recovery.
- [Provider events and capture](./docs/glossary/provider-events-and-capture.md) — event sources, normalization, hooks, logs, and PTY fallback.
- [Grill and stage flow](./docs/glossary/grill-and-stage-flow.md) — transcript terms, markers, phases, and session scope.
- [Run and execution](./docs/glossary/run-and-execution.md) — runs, provider-authored issues, execution, and summaries.
- [Diagnostics](./docs/glossary/diagnostics.md) — internal logs, correlation, and terminal failure messages.

## Architecture decisions

Durable architecture decisions live in [docs/adr](./docs/adr/).
