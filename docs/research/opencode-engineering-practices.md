# Transferable OpenCode Engineering Practices For Crucible

## Executive Answer

Crucible should copy OpenCode's discipline, not its shape. The strongest transferable practices are domain-local ownership, deep Modules with narrow Interfaces, private mechanisms, explicit dependency direction, realistic fixtures, replacement followed by deletion, and runtime alignment. Crucible should adapt OpenCode's test layout, public entrypoints, hierarchical `AGENTS.md` files, and progressive skill/document loading to a single-package codebase. It should reject a pre-emptive monorepo, an Effect service graph, a Bun migration, broad wildcard exports, and documentation volume that is justified only by OpenCode's scale.

The downstream decision is not whether context-efficient guidance is useful. It is how Crucible will make a brief authoritative index, domain-local instructions, and need-triggered detail discoverable without hiding safety-critical rules or loading the whole architecture into every agent turn.

## Scope And Method

This answers [issue 10](https://github.com/DevFlow-HQ/devflow-cli/issues/10) as targeted research, not an implementation plan or whole-codebase review.

- Crucible baseline: the repository is currently one strict TypeScript/npm package with one `src/` tree and a mirrored top-level `tests/` tree ([package.json](https://github.com/DevFlow-HQ/devflow-cli/blob/bd1847f0df3e362342da8ef3c40363ac4d394c23/package.json), [CONTEXT.md](https://github.com/DevFlow-HQ/devflow-cli/blob/bd1847f0df3e362342da8ef3c40363ac4d394c23/CONTEXT.md)).
- OpenCode evidence is pinned to local checkout commit [`38e10eb1408feb700021b8e8766fb0ab41bf84e2`](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2). URLs below are commit-pinned; no claim depends on the current default branch.
- The sample is deliberately representative: root and applicable local agent instructions, package manifests and CI, the Core Tool Module, client entrypoint checks, representative source/test trees, shared temporary-resource fixtures, one recorded protocol fixture, one completed deletion spec, and instruction/skill disclosure code.
- Repetition or an explicit instruction is treated as a practice. One isolated file is evidence of possibility, not a repository standard. Mixed evidence is reported as mixed.
- OpenCode is evidence, not authority. Each recommendation is evaluated against Crucible's smaller scale and existing domain language.

## Findings

### 1. Domain And Folder Organization: Adopt

**Evidence.** OpenCode's application package groups source by recognizable domains such as `config`, `project`, `provider`, `session`, `storage`, and `tool`, rather than by generic technical roles ([source tree](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src)). The `session` directory contains independently named sibling Modules and no catch-all barrel ([session tree](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session)); package guidance explicitly says multi-sibling directories should expose specific siblings rather than an `index.ts` that evaluates everything ([package AGENTS.md, lines 58-70](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/AGENTS.md#L58-L70)). Local Tool guidance names the folder's ownership and excludes duplicate executable representations and legacy paths ([Tool AGENTS.md, lines 1-16](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/tool/AGENTS.md#L1-L16)).

**Crucible decision.** Adopt domain ownership and locality, but add a folder only when a domain has several independently named concepts. Keep one package until deployment, runtime, ownership, or external-consumer needs create a real package seam. Do not reproduce OpenCode's package count or create the proposed future domain tree in advance.

**Enforcement.** Documentation first: glossary, ownership notes, and review. Add an import-boundary test only after a dependency rule has both a stable domain seam and meaningful failure cost.

### 2. Deep Module Interfaces: Adopt

**Evidence.** OpenCode's Core Tool Module demonstrates Depth as leverage rather than file size. `Tool.make(...)` accepts schemas, execution, and projection policy while returning an opaque frozen value; a private `WeakMap` retains runtime behavior ([tool.ts, lines 18-25 and 63-76](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/tool/tool.ts#L18-L25), [lines 69-132](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/tool/tool.ts#L69-L132)). Its registry presents two top-level operations, then hides registration precedence, scoped cleanup, validation, filtering, stale-call handling, output encoding, and generic output bounding ([registry.ts, lines 23-40](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/tool/registry.ts#L23-L40), [lines 42-123](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/tool/registry.ts#L42-L123)). A narrower registration-only capability exists for callers that do not need settlement ([tools.ts](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/tool/tools.ts)). Tests assert opacity and the absence of settlement methods on the broader service surface ([application-tools.test.ts, lines 41-83](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/test/application-tools.test.ts#L41-L83), [session-runner-tool-registry.test.ts, lines 219-227](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/test/session-runner-tool-registry.test.ts#L219-L227)).

**Crucible decision.** Adopt the design test: a Module should hide decisions, invariants, and failure translation behind the smallest useful Interface. Preserve cohesive orchestration where ordering is the responsibility; do not equate Depth with many services or interfaces. Crucible can use ordinary functions and objects rather than OpenCode's Effect services.

**Enforcement.** Interface-focused tests can mechanically protect observable behavior and intentional absence of capabilities. Whether an Interface is deep remains a design-review judgment supported by the deletion test: removing the Module should force complexity into callers.

### 3. Encapsulation And Module Shape: Adapt

**Evidence.** OpenCode package guidance requires flat ESM exports, namespace self-reexports, and unexported top-level helpers; it rejects TypeScript namespaces and multi-sibling barrels for runtime and tree-shaking reasons ([package AGENTS.md, lines 15-44](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/AGENTS.md#L15-L44)). The Tool carrier makes codecs and execution inaccessible to consumers even at runtime ([tool.ts, lines 69-76 and 148-155](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/tool/tool.ts#L69-L76)). Root style guidance also says to keep one-caller logic local unless extraction hides a genuinely complex seam or names an independent concept ([root AGENTS.md, lines 23-35](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/AGENTS.md#L23-L35)).

**Crucible decision.** Adopt private helpers, explicit exports, and cohesive files. Adapt the self-reexport syntax rather than standardizing it now: Crucible should follow its existing ESM style unless namespace projection solves a demonstrated naming or import problem. Reject one-file-per-helper refactors.

**Enforcement.** TypeScript visibility and explicit export lists are mechanical. Helper granularity and cohesion are documentation/review guidance.

### 4. Public Entrypoints: Adapt

**Evidence.** OpenCode is intentionally mixed. The browser client exposes only `.` and `./effect` ([client package.json, lines 7-10](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/client/package.json#L7-L10)); a bundle-metafile test proves that the root excludes Effect, Schema, Protocol, Core, and Server, while `./effect` includes only Effect, Schema, and Protocol ([client import-boundaries.test.ts, lines 13-30](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/client/test/import-boundaries.test.ts#L13-L30)). `sdk-next` also exposes only its root ([sdk-next package.json, lines 7-9](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/sdk-next/package.json#L7-L9)). In contrast, `opencode`, Core, Schema, Protocol, and Server retain wildcard subpath exports ([opencode package.json, lines 21-23](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/package.json#L21-L23), [Core package.json, lines 18-24](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/package.json#L18-L24)). Therefore narrow package exports are a targeted compatibility/runtime tool, not a universal OpenCode standard.

**Crucible decision.** Keep the CLI's package surface explicit and small. Add named subpath entrypoints only for real external consumers; do not turn every internal Module into a public package path. Reject OpenCode's wildcard exports as a default for Crucible.

**Enforcement.** Use `package.json` `exports`, package smoke tests, and bundle/import-boundary tests where browser/runtime isolation matters. Review remains responsible for deciding whether a new public entrypoint is justified.

### 5. Dependency Direction: Adopt

**Evidence.** OpenCode's root instructions define runtime direction from Schema to Core/Protocol to Server and prohibit Client runtime imports from Core or Server ([root AGENTS.md, lines 1-4](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/AGENTS.md#L1-L4)). Package manifests reflect that direction: Protocol depends on Schema, Server depends on Core and Protocol, and Client runtime dependencies are Schema and Protocol ([Protocol package.json, lines 13-16](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/protocol/package.json#L13-L16), [Server package.json, lines 14-18](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/server/package.json#L14-L18), [Client package.json, lines 17-20](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/client/package.json#L17-L20)). The client boundary test mechanically protects the most consequential runtime restriction. HTTP guidance separately keeps transport types out of domain/storage Modules and translates errors at the handler seam ([HTTP AGENTS.md, lines 31-39](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/server/routes/instance/httpapi/AGENTS.md#L31-L39)).

**Crucible decision.** Adopt explicit direction using Crucible's own layers: presentation must not import provider adapters; provider payloads remain adapter-local; generic runtime does not own workflow policy; persistence does not depend on presentation. Keep these as source-folder rules until real package seams emerge.

**Enforcement.** Mechanically test a small set of high-cost forbidden imports. Do not introduce a package graph or a general architecture framework solely to enforce direction.

### 6. Test Organization: Adapt

**Evidence.** `packages/opencode/src` and `packages/opencode/test` mirror many domain folders, including `config`, `project`, `provider`, `session`, `storage`, and `tool` ([source tree](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src), [test tree](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/test)); `session` is a representative direct mirror ([source session](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session), [test session](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/test/session)). The pattern is not universal: Core keeps many domain tests flat under [`packages/core/test`](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/test), and UI packages can colocate tests such as [`scroll-view.test.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/ui/src/components/scroll-view.test.ts). Explicit policy is behavioral instead: avoid mocks, exercise actual implementation, and run tests from package directories ([root AGENTS.md, lines 141-149](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/AGENTS.md#L141-L149)).

**Crucible decision.** Retain the existing top-level `tests/` tree and mirror production domains as they emerge. Colocate only when a framework or asset workflow makes it materially clearer. Test a Module through the same Interface callers use; distinguish pure, contract, integration, fixture-replay, and opt-in smoke coverage by behavior, not by multiplying directories prematurely.

**Enforcement.** Test commands and required suites are mechanical. Mirroring and test-layer choice are conventions checked in review.

### 7. Real Resources And Replayable Fixtures: Adopt

**Evidence.** OpenCode's test-local instructions document one temporary-directory fixture with Git, config, initialization, and disposal ([test AGENTS.md, lines 3-25](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/test/AGENTS.md#L3-L25)), plus Effect-aware variants ([lines 83-123](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/test/AGENTS.md#L83-L123)). The implementation creates real temporary directories and optional Git repositories, then guarantees cleanup ([fixture.ts, lines 78-119](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/test/fixture/fixture.ts#L78-L119)). The instructions prohibit wall-clock sleeps as synchronization and require observable readiness signals ([test AGENTS.md, lines 161-177](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/test/AGENTS.md#L161-L177)). Recorded LLM tests replay HTTP while leaving request execution and the OpenCode LLM stack real ([llm-native-recorded.test.ts, lines 262-287](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/test/session/llm-native-recorded.test.ts#L262-L287)); cassettes include protocol metadata and redacted request/response bodies ([Anthropic cassette, lines 1-27](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/test/fixtures/recordings/session/native-anthropic-tool-loop.json#L1-L27)).

**Crucible decision.** Adopt shared real temp-directory/Git fixtures, deterministic readiness, and replayable provider protocol fixtures. Record only at true external seams, redact secrets and unstable identifiers, identify protocol/version provenance, and keep a documented refresh path. Do not make installed-provider smoke tests part of the deterministic default suite.

**Enforcement.** Fixture tests, secret scanning, cleanup assertions, and no-sleep lint/search checks can be mechanical. Deciding when a recording remains representative requires review.

### 8. Refactoring, Compatibility, And Deletion: Adopt

**Evidence.** OpenCode's root style guide rejects pre-emptive single-use extraction ([root AGENTS.md, lines 23-35](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/AGENTS.md#L23-L35)). Its completed database-removal plan moved callers to deeper Modules or a lower-level adapter rather than deleting SQLite wholesale ([remove-opencode-db.md, lines 1-17](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/specs/storage/remove-opencode-db.md#L1-L17)); it sequenced work around preserved transaction invariants, then records the legacy wrapper as deleted ([lines 65-108](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/specs/storage/remove-opencode-db.md#L65-L108), [lines 218-239](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/specs/storage/remove-opencode-db.md#L218-L239)). Schema guidance keeps compatibility only for active consumers/migrations and directs deletion of V1 after retirement ([Schema AGENTS.md, lines 12-19](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/schema/AGENTS.md#L12-L19)).

**Crucible decision.** Refactor when a product slice crosses a seam: preserve named invariants, replace behind stable Interfaces where needed, migrate real callers, then delete obsolete behavior and tests. Reject speculative compatibility and broad cleanup of code already scheduled for removal.

**Enforcement.** Reference searches, dependency checks, focused/full tests, and deletion of dead exports are mechanical. Migration order and compatibility need are documented design decisions.

### 9. Package And Runtime Discipline: Adapt

**Evidence.** OpenCode pins Bun in `packageManager` and deliberately prevents root test execution ([root package.json, lines 5-24](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/package.json#L5-L24)); its workspace catalog centralizes many exact dependency versions ([lines 25-96](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/package.json#L25-L96)). Bun installation is exact and applies a minimum release age ([bunfig.toml](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/bunfig.toml)); the pre-push hook checks the local Bun version and runs type checking ([pre-push, lines 1-20](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/.husky/pre-push#L1-L20)). CI installs the pinned toolchain, runs package tests across Linux and Windows, checks generated client drift, and exercises HTTP contracts ([test workflow, lines 39-80](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/.github/workflows/test.yml#L39-L80)).

**Crucible decision.** Adopt alignment, not the specific tools: keep the pinned toolchain, `engines`/build target, native dependency pins, CI runtimes, and the packaged-binary smoke mutually consistent. Centralize versions only when duplication exists. Crucible **adopts Bun** as its toolchain and single-file-executable target ([ADR 0030](../adr/0030-ship-the-shell-as-a-bun-compiled-single-file-executable.md), superseding the earlier "keep npm/Node, reject a Bun migration" stance after the [#60](https://github.com/secantdev/secant/issues/60#issuecomment-5623212589) Windows soak passed); it still rejects a workspace catalog, patches, or monorepo tooling without a Crucible requirement.

**Enforcement.** CI matrix, lockfile validation, typecheck/build/test, generated-file drift checks, dependency-pin tests, and packaged executable smoke tests are mechanical. Dependency purpose and patch justification remain review/documentation concerns.

### 10. Hierarchical Agent Guidance: Adapt

**Evidence.** OpenCode has repository, package, test, and feature-local instructions. The project command for preserving learnings says to place only non-obvious guidance at the nearest applicable directory, keep each insight to one to three lines, and avoid duplication or session-specific detail ([learn.md, lines 5-40](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/.opencode/command/learn.md#L5-L40)). Local examples define ownership and invariants for Core Tool ([Tool AGENTS.md](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/tool/AGENTS.md)), LLM adapter seams ([Session LLM AGENTS.md, lines 1-32](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/llm/AGENTS.md#L1-L32)), test fixtures ([test AGENTS.md](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/test/AGENTS.md)), and HTTP translation ([HTTP AGENTS.md](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/server/routes/instance/httpapi/AGENTS.md)). This is strong evidence for locality, but OpenCode's 161-line root file also contains detailed V2 Session rules, so it is not evidence that every root index stays brief.

**Crucible decision.** Use a short root `AGENTS.md` as an authority and navigation index. Add local files only after a substantial domain repeatedly requires discovery of ownership, prohibited dependencies, invariants, Interface, test command, or relevant ADR. Do not create one in every folder, duplicate global prose, or store transient task state there.

**Enforcement.** Link checking, duplicate-heading checks, and maximum-scope metadata could be mechanical later. Relevance, non-obviousness, and correct scope require review.

### 11. Progressive Documentation Disclosure: Adapt, Exact Mechanism Unresolved

**Evidence.** OpenCode's product exposes a list of skill names/descriptions in system context and loads full `SKILL.md` content only through the skill tool ([system.ts, lines 98-109](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/system.ts#L98-L109), [skill tool, lines 27-51 and 57-100](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/tool/skill.ts#L27-L51)). Its instruction Module loads global/root guidance initially, then walks upward from a file being read and attaches nearby instructions once per message ([instruction.ts, lines 110-168](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/instruction.ts#L110-L168), [lines 179-220](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/instruction.ts#L179-L220)). This validates the architecture of a small index plus need-triggered detail. It does not prove the right token budget, inheritance rules, or document taxonomy for Crucible. There is also a concrete stale-link warning: `packages/opencode/AGENTS.md` points to `specs/effect/migration.md` ([lines 72-77](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/AGENTS.md#L72-L77)), but that path is absent at the pinned commit.

**Crucible decision.** Adapt the pattern: always provide a concise map and mandatory cross-cutting constraints; load detailed workflows, domain rules, ADRs, fixtures, and provider knowledge only when a task or touched path makes them relevant. Keep safety-critical rules in the always-visible layer or make their trigger deterministic. The exact mechanism is unresolved and belongs in a decision ticket.

**Enforcement.** A docs index/link validator and tests for deterministic path-to-guidance discovery are mechanical. What belongs in baseline context versus need-triggered detail is a product and architecture decision.

## Explicit Rejections

| OpenCode shape                                   | Crucible classification | Reason                                                                                                                 |
| ------------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Monorepo/package count and Turbo workspace graph | **Reject**              | Crucible has one deployable CLI and no demonstrated ownership/runtime seams requiring packages.                        |
| Effect service/layer graph                       | **Reject**              | Deep Interfaces and dependency injection are transferable; OpenCode's chosen framework is not.                         |
| Bun APIs/toolchain and workspace catalog         | **Reject**              | Crucible's supported runtime is Node/npm. Changing it must be justified by product/runtime evidence, not imitation.    |
| Wildcard package subpath exports                 | **Reject as default**   | OpenCode itself uses narrow entrypoints where isolation matters; Crucible should expose only current consumers' needs. |
| A local `AGENTS.md` in every folder              | **Reject**              | Empty/generic hierarchy adds context and authority ambiguity without reducing discovery.                               |
| Full design history in baseline agent context    | **Reject**              | Context should carry current constraints and routes to need-triggered detail, not every historical decision.           |

## Mechanical Checks Versus Guidance

| Concern              | Mechanical now or when its seam exists                                                | Documentation/review only                                       |
| -------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Dependency direction | Focused forbidden-import tests for presentation/provider/runtime violations           | Decide ownership and allowed direction from Crucible's glossary |
| Public surface       | Explicit `exports`, package smoke test, bundle/import-boundary test                   | Justify each new external entrypoint                            |
| Runtime discipline   | Lockfile, engine/type/build/CI alignment, typecheck, test, packaged startup           | Explain dependency and patch purpose                            |
| Generated artifacts  | Regenerate-and-diff CI gate                                                           | Decide what is generated and authoritative                      |
| Tests/fixtures       | Default deterministic suite, cleanup assertions, secret scan, opt-in live smoke suite | Choose the right test layer and representative fixture cases    |
| Refactoring/deletion | Reference search, no dead exports, focused/full tests                                 | Preserve named invariants and justify compatibility             |
| Module Interface     | Type-level exports and black-box Interface tests                                      | Judge Depth, cohesion, and seam placement                       |
| Agent guidance       | Link/index validation and deterministic scope lookup                                  | Decide what is non-obvious, current, and correctly scoped       |

Do not add a general architecture linter merely because one is possible. Start with the few rules whose violation would silently couple providers, workflow policy, persistence, or presentation.

## Downstream Decision Ticket Constraints

A later decision ticket should settle one coherent **agent-context architecture**, not four unrelated documentation chores.

1. **Brief index.** Define the authoritative root index, its maximum responsibility, and where it points for glossary, ADRs, domain instructions, test commands, and active plans. Define precedence and supersession so ignored `.agent/` history cannot silently outrank tracked current guidance.
2. **Need-triggered detail.** Specify deterministic triggers: touched path, task type/skill, named domain, or explicit link. Decide which constraints must always be visible because missing them is unsafe. Define how an agent discovers available detail without scanning the repository.
3. **Domain-local instructions.** Set the creation threshold and required contents: what the domain owns, must never own, its Interface, dependency direction, invariants, test entrypoint, and relevant glossary/ADR links. Define inheritance and conflict resolution between root and local guidance.
4. **Context-efficient AI-native development.** Choose a measurable context budget or evaluation method, prevent duplicated prose, validate links, and test representative tasks for whether agents find the right guidance with less irrelevant context. Optimize successful navigation and change safety, not merely token count.

The ticket should preserve these constraints:

- Current authoritative policy must be tracked and reviewable.
- Safety-critical rules cannot depend on a probabilistic search or optional skill invocation.
- Detailed provider/workflow knowledge should remain local and load only when relevant.
- A local document must reduce repeated discovery enough to pay for its maintenance and context cost.
- Every index link must be mechanically checked; OpenCode's missing Effect migration link demonstrates the failure mode.
- The design must work before and after Crucible gains more domain folders; it must not require a monorepo.

## Decision Questions And Fog

- **Naming authority:** issue 10 calls the product Crucible while tracked package/docs still call it DevFlow. Which name should future domain guidance treat as canonical, and when does that become a tracked migration rather than research terminology?
- **Guidance authority:** the supplied `.agent/code-quality-guidelines.md` and `.agent/codebase_review.md` were available only as ignored main-worktree context, not tracked on this branch. Should their durable conclusions move into tracked agent/domain docs, or should the later decision supersede them?
- **Boundary timing:** which two or three dependency violations are costly enough to enforce immediately, before the proposed workflow/harness/TUI domains exist?
- **Disclosure mechanism:** should need-triggered detail be path-loaded `AGENTS.md`, explicit skills, linked domain guides, or a hybrid? The decision must specify deterministic triggers and baseline safety rules.
- **Fixture governance:** who may refresh recorded provider fixtures, what provenance/redaction metadata is required, and how is semantic drift reviewed?

## Gist

Adopt OpenCode's locality, deep Interfaces, realistic tests, explicit dependency direction, replacement-and-deletion discipline, and runtime alignment. Adapt its hierarchy and progressive disclosure into a small tracked index plus deterministic domain/task-triggered detail. Reject its scale, framework, runtime, wildcard exports, and documentation volume unless Crucible develops the same underlying needs.
