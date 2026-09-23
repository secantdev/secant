# Own a Truthful Deep Harness Seam Instead of Emulating Harness Parity

Crucible owns one deep **Harness Adapter** Module that translates Harness-native launch, conversation, event, control, recovery, failure, and cleanup
semantics into a Crucible Interface. Its conceptual shape is `prepare -> PreparedHarness`, `startTurn -> HarnessTurn`, and `close -> CleanupReport`;
a Turn exposes one ordered event stream, one sole authoritative result, and a closed control operation. Exact type names remain an implementation
choice, but the ordering, ownership, and failure rules are part of the Interface. The caller is Crucible's Run/Step execution Module, never the TUI:
raw Harness evidence flows through the Adapter to that caller and then through the **Projection Port**. The Adapter therefore knows no Workflow
Bundle, Step kind, retry budget, Routing, or Run state, and offers no raw-provider client or protocol escape hatch. This decision resolves
[Define the truthful Harness capability and Adapter contract](https://github.com/DevFlow-HQ/devflow-cli/issues/8).

`prepare` performs non-conversational Preflight qualification and returns an immutable semantic profile tied to the observed executable, version,
platform, configuration posture, and Adapter revision. The profile uses evidence-bearing variants rather than flat booleans: recovery distinguishes
native reattach, load-with-replay, and unavailable; interruption distinguishes confirmed active-Turn interruption, process-only stop, and
unavailable; approvals and structured clarifications are independent; model selection reports where it can occur; and recovery-coordinate timing
states whether durable recording can precede submission. Step kinds declare required capabilities and Preflight checks their union. Optional UI
features use the same profile. If reality drifts, the Adapter may requalify only when it can prove equivalent semantics; Crucible never fills a gap
with PTY inference, a weaker operation, or a silent Harness switch.

A **Turn** is one mechanical exchange inside a named **Harness Session**, not a Session and not a judgement that a Step succeeded. Crucible supplies
an opaque correlation key, and `startTurn` returns a handle before native acceptance; that key is not an exactly-once promise, so uncertain
submission is never automatically retried. A Prepared Harness allows one active Turn while privately retaining multiple idle named conversations.
Sessions open or recover lazily and report `open`, `detached`, or `unusable` independently of every Turn outcome. The closed Turn results are
`not-started`, `completed`, `failed`, `interrupted`, and `lost`: `completed` means only an authoritative Harness boundary, while `lost` means effects
may have started but no terminal truth survived qualified, safe, read-only recovery probes. Lost detail records whether acceptance, completion, or
interruption is unknown and the last authoritative observation. The Step kind, above this Seam, decides the Attempt outcome and retry policy.

The event stream preserves every user-meaningful assistant, tool, command, file-edit, subagent, request, retry, failure, model, session, and recovery
fact; unknown but displayable work becomes generic activity. Context-window pressure is prominent when observed or honestly calculable, while usage,
cost, and rate facts are optional and estimates stay labelled. Raw protocol frames, private reasoning, telemetry, and ordinary stderr remain private.
The Adapter drains the native transport independently of a slow TUI, coalesces only replaceable previews, closes the producer after all final facts
are queued, and only then settles the result; no event can follow it. The result alone carries terminal status, authoritative final assistant content
when available, the effective-model observation, post-Turn Session availability, and structured failure.

Controls are closed and stateful. `steer` means native same-Turn input only; `answer-request` addresses one exact ephemeral approval or structured
clarification; `interrupt` means Harness-confirmed termination of the active Turn and its native work. Ordinary turn-taking calls `startTurn` again,
and ending an Interactive agent step remains a Crucible control above the Seam. Expected races return an accepted or rejected receipt rather than
throwing. Acceptance does not prove final effect: after an accepted interrupt the Adapter rejects new inputs, drains to native terminal evidence,
and the Turn result confirms whether interruption occurred. Harness Requests are Turn-scoped, independently keyed, may coexist, and expire when the
Turn ends, is interrupted, or is lost; an ordinary assistant question at a Turn boundary is not a Harness Request.

Native conversation identifiers are opaque recovery coordinates, never Run truth. When one is observable before submission, the Adapter awaits a
Crucible-owned durable recorder before sending content; recording failure proves `not-started`. When a Harness reveals it only after acceptance, the
profile exposes that unavoidable crash window and the Adapter records it immediately. A late recording failure cannot falsify the Turn result: the
Adapter continues draining, reports the checkpoint failure separately, and does not claim durable recovery. Recovery never silently creates a fresh
conversation. Load-with-replay keeps old transcript content visibly historical, reconciles duplicates, and establishes a history/live barrier before
new progress. A settled result is immutable; later evidence is appended as reconciliation rather than rewriting history.

Operational failures are typed values, preserving phase, category, possible effects, partial output, native code, retry evidence, useful diagnostics,
and the original cause; only trusted caller-contract violations throw. Authentication failures direct the user to log in separately through the
named Harness. Unlike the legacy metadata-only diagnostic default in [ADR 0011](https://github.com/secantdev/secant/blob/legacy-devflow/docs/adr/0011-adapter-diagnostic-tracing-is-metadata-only.md), this target
Interface exposes all useful Harness-originated diagnostic information to the Harness owner and preserves its cause. It redacts only secrets Crucible
itself introduces; excluding raw protocol, private reasoning, and duplicate transcript content is Interface design, not generic secret redaction.
Requested and effective models remain distinct, native read-only evidence is used proactively, provider fallback is shown, and an unconfirmed
effective model stays unknown rather than copying the request.

Crucible does not transport credentials through this Interface: authentication and configuration remain owned by the user's Harness installation.
Timeouts apply only to a closed set of mechanical operations—launch/protocol initialization, open/recovery handshakes and status probes, immediate
control acknowledgement, and cleanup—never to agent thought, tools, subagents, approvals, clarifications, or a whole Turn. `close` is idempotent,
rejects new work, expires requests, attempts supported graceful interruption, closes transports, and then bounds termination and process-tree reaping.
Force-killing a Turn already proven complete is cleanup; killing unconfirmed active work produces `lost`. Cleanup failure is separate and cannot
rewrite a settled Turn. Ownership transfers once from Preflight to the Run, so exactly one owner is always responsible for cleanup.

This Interface is also the test surface: every shipped Harness Adapter implements it beside a deterministic fake; a shared conformance suite exercises
ordering, requests, controls, recovery, failure, and cleanup, while private versioned protocol fixtures and opt-in pinned real-runtime qualification
cover native drift. The shipped Harness portfolio is a product-scope decision rather than part of this architecture. OpenCode supplied useful examples
of exact IDs, durable admission, and session tracking, but its types, event vocabulary, state providers, and domain model do not cross the Seam,
consistent with [ADR 0018](./0018-adopt-opencode-presentation-as-pinned-reduced-vendor.md). We
rejected a minimal `qualify/turn/close` facade because it hides stateful interaction and recovery, a broad capability object graph because it leaks
mechanism and invites caller coupling, and a whole-Step `execute` API because it drags orchestration below the Seam. The chosen prepared-Harness
hybrid is narrower in vocabulary but deeper in guarantees; its cost is a stricter Adapter and conformance burden in exchange for truthful differences
and one stable caller contract.

## Amendment (2026-09-07): skills, protocol drift, and model lists

Recorded while [approving the migration handoff](https://github.com/DevFlow-HQ/devflow-cli/issues/22). A `skill` Bundle Asset reaches every
Harness by **plain-path delivery** in v1: the Adapter places the skill directory in the Run's read-only asset space and the rendered prompt tells the
agent to read its `SKILL.md`. Native skill delivery is a later version and, when it arrives, becomes a profile fact (`native` or `plain-path`)
rather than a Preflight requirement, because plain-path is a real delivery and not an emulated control. Qualification of an installed Harness whose
protocol is unversioned (Codex app-server) runs the pinned conformance probe against whatever is installed: pass means usable, fail means the
Harness is `unavailable` with a typed reason, never best-effort parsing. A Workflow Bundle never selects or constrains a model in v1; the Adapter
profile supplies the model list when the Harness exposes one and declares free-text entry otherwise. A non-binding recommended model authored in
the Bundle is deferred to a later version. (Edited 2026-09-23: M5 shipped this as two profile fields. `modelSelection` declares where a model can be
selected and carries a `list` or `free-text` model declaration, or declares selection `unavailable`; `modelObservation` declares whether the Adapter
reads the effective model from native evidence, independent of selection. A caller's requested model outside a declared list is a typed
`model-unavailable` prepare failure, never a substitution.)

## Amendment (2026-09-18): delivery mode is the Adapter's, substitution is the caller's

Recorded while tidying the M3 audit
([#129](https://github.com/secantdev/secant/issues/129), audit [#127](https://github.com/secantdev/secant/issues/127)).
The 2026-09-07 amendment above read as if the Adapter renders the prompt. It does not. What the Adapter owns, and the profile declares, is the delivery
**mode** — `native` or `plain-path` for a skill, and the equivalent `FileDelivery` mode for file artifacts. Substituting Bundle artifacts into the prompt
text is the **caller's**, because rendering needs the Bundle input and asset knowledge this ADR keeps out of the Adapter (the Adapter knows no Workflow
Bundle). The caller renders the prompt text and hands it in as the Turn's semantic input; the Adapter chooses only how each declared asset is delivered.

## Amendment (2026-09-21): Harness portfolio is product scope

Recorded while [choosing whether OpenCode earns the third v1 Harness slot](https://github.com/secantdev/secant/issues/175). The original decision's
named three-Adapter portfolio was a migration-plan fact, not an architectural constraint. The Harness Seam applies unchanged to every shipped Adapter;
the current portfolio and any qualification condition live in the product-scope and sequencing decisions.
