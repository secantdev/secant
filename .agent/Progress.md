# DevFlow Progress
_Last updated: 2026-09-06_

Use this file for completed work only. Keep destination/architecture details in `HANDOFF_2.md` and `new_spec.md`.
Hard limit: 100 lines.

## Done
- Target Module ownership and multi-file composition guidance are recorded in ADR 0025 and `docs/agents/topology.md`; an AST/resolver-based import gate adds 20 tests without production-source or dependency changes.
- Architecture, MVP scope, library choices, state layout, provider integration direction, and implementation order are captured in `HANDOFF_2.md`, `new_spec.md`, and `.agent/task_progress.md`.
- Node/TypeScript CLI scaffold is in place with strict ESM TypeScript, `devflow` bin mapping, `tsup`, package lock, runtime/dev dependencies, and repo `.gitignore`.
- CLI/bootstrap foundation is complete: free-form task parsing, help/version passthrough, Git-root resolution, provider/model overrides, first-run provider setup, default-provider config validation/repair, and concise provider/session error mapping.
- `.devflow` state boundary is complete: repo-local config/context/run state, immutable stage artifacts, normalized issue writes, grill transcript/checkpoint state, diagnostic log paths, provider-session recovery metadata, typed domain errors, and idempotent target-repo `.gitignore` updates.
- Project-context freshness and bootstrap are complete: bounded `.devflow/project-context.md`, metadata with Git/dirty baselines, relevant-change freshness checks, provider refresh/repair, and provenance tracking.
- Managed-session adapter foundation is complete: built-in Claude/Gemini/Codex/OpenCode identity metadata, discovery, `runSession(...)`, optional resume, validation/repair/continuation config, normalized provider events, capabilities, and typed lifecycle failures.
- Provider selection deferral is complete: Claude and Codex are the only user-selectable Supported MVP providers; Gemini/OpenCode remain wired as Deferred adapters and are hidden from discovery, first-run selection, saved defaults, and explicit provider selection.
- Shared PTY control is complete: `src/adapters/ptyControlHarness.ts` owns spawn/control, stdin forwarding, resize forwarding, output mirroring, cleanup, kill/write helpers, and PTY tracing; hook/JSONL runners delegate common process control while preserving provider-specific data planes.
- Provider event/capability architecture is complete: orchestration consumes provider-neutral `session-start`, `submitted-user-message`, `turn-completed`, and `session-completed` events with provider/source/phase metadata; provider-specific schemas stay inside adapters.
- Structured provider sources are complete for Codex: hook mode is the default data plane, JSONL mode is internally selectable, scoped rollout logs are watcher-tailed, fresh/resume paths preserve PTY interactivity, and Codex resume uses reliable provider session ids.
- Structured provider sources are complete for Claude: hook mode normalizes Claude hook events and supports native resume; JSONL mode uses scoped provider home/credential seeding, transcript discovery/tailing, JSONL resume, and selected-path capability reporting.
- Structured grill transcript capture is complete: assistant content comes from structured `turn-completed.assistantMessage`, only human-origin submitted messages are recorded, managed/unknown submissions are excluded, and repair discussion remains captured until accepted.
- Provider session recovery is complete: runs persist advisory `provider-session.json`, recover from durable artifacts first, degrade malformed/stale state where possible, and resume reliable interrupted grill/PRD phases before falling back to artifact-based synthesis.
- Active provider-backed stages are complete through PRD: intent validation/repair, mandatory grill with checkpointing/resume, PRD continuation/synthesis/repair, and retry classification for provider-backed stage failures.
- Issue decomposition is complete: provider-backed `issues` stage writes run-scoped markdown issues, validates only non-empty markdown existence per ADR-0009, supports same-session repair and clean two-attempt retry, and keeps provider-authored issue content isolated from downstream arbitration.
- Execution stage activation is complete: execution prompts include open issues/recent commits/TDD references, managed sessions support iteration and terminal markers, execution ledgers record per-iteration/session/head state, and the bounded fresh-session loop stops on terminal/no-file/cap/error outcomes without resuming execution sessions.
- MVP CLI UX is complete: the live stage list is `intent`, `bootstrap`, `grill`, `prd`, `issues`, and `execute`; the old `validate` placeholder/artifact mapping is removed; stage-start lines, mapped failures, and success/failure run summaries render from on-disk artifacts.
- Diagnostic logging is complete: injected JSONL logging supports levels, serialized errors, critical correlation refs, repo-local-to-home fallback, 30-day pruning, anticipated-vs-unexpected CLI failure split, orchestrator lifecycle/degradation logs, and adapter-deep debug tracing without prompt/message bodies.
- Completion-marker prompt discipline is complete: `CONTEXT.md` and stage/repair/resume prompts define exactly-once marker emission, immediate advancement, failure modes, and the grill-only conclusion approval handshake.
- Maintainer documentation/tests pin structured provider constraints, structured grill transcript policy, provider-native boundary isolation, Codex hook/JSONL behavior, Claude hook/JSONL behavior, PTY fallback/control boundaries, diagnostic logging, execution ledgers, and prompt marker contracts.
- Release/docs readiness is complete:
  - `LICENSE` contains the standard MIT license with `Copyright (c) 2026 DevFlow-HQ`.
  - `package.json` is publish-ready without publishing: `main` points at `dist/cli.js`, package name remains `devflow-cli`, bin remains `devflow`, metadata points at `github.com/DevFlow-HQ/devflow-cli`, `license` is MIT, `engines.node` matches the Node 20.19 runtime floor, and keywords/author/contributors are filled in.
  - `README.md` now presents DevFlow as an early experimental CLI, documents only Claude and Codex as supported providers, leads with working from-source install steps, marks `npm install -g devflow-cli` as not yet on npm, states that the command is `devflow`, includes a first-run example, and links deeper architecture to `CONTEXT.md`.
- Claude and Codex JSONL post-exit drain race is fixed: both runners keep serialized structured-log drains alive after PTY exit until marker finalization or the existing early-exit timeout, with deterministic `read-in-progress` regression coverage and 100-run Claude JSONL stress verification.
- Global linked CLI entrypoint is fixed: `src/cli.ts` now resolves symlinked bin paths before deciding whether to run, with regression coverage for npm/Volta-style symlink execution.
- Claude scoped credential lifetime is bounded to completed structured sessions: JSONL and hook-driven runners delete scoped `.credentials.json` during successful cleanup, tolerate absent credentials, and keep launch-time credential seeding available to Claude.
- The authoritative engineering gate is enabled through `npm run check`: Node 20-aligned types/build/runtime metadata, Prettier verification, zero-warning ESLint, recursive deterministic test discovery, production build, installed-tarball help/version smoke, and clean-install GitHub Actions CI all pass; the stale project-context baseline refresh typo is fixed.

## Current State
- The working pipeline is active through `intent`, `bootstrap`, `grill`, `prd`, `issues`, and `execute`.
- MVP no longer includes a `validate` stage; `execute` is the terminal provider-backed stage.
- Only Claude and Codex are user-selectable Supported providers; Gemini/OpenCode remain wired Deferred adapters outside discovery, first-run selection, saved-default resolution, and explicit-provider selection.
- Codex hook/JSONL and Claude hook/JSONL structured paths use the shared PTY control harness for process control and normalized provider events as the data plane.
- End-user release-facing files now exist and align with the supported-provider boundary: `README.md`, `LICENSE`, and publish metadata in `package.json`.
- Latest isolated tracked-source verification used `npm ci --offline` and `TZ=UTC npm run check`: all 559 tests, lint/types/format, build, and installed-package smoke passed. UTC aligns an existing Git-date test; untracked `ai-resume.md` prevents the shared worktree's full format check.
- No AFK issues remain in `.agent/task_progress.md` or `.agent/issues/done` for the current release/docs, project-context freshness, managed-session/retry, bootstrap, grill/PRD, issue decomposition, execution, MVP CLI UX, structured transcript, provider-session recovery, Codex JSONL resume, Claude hook-mode, Claude JSONL, diagnostic logging, completion-marker prompt, provider selection deferral, or PTY control harness workstreams.
- Latest completed maintenance: topology import enforcement and Interface-focused test fixtures are verified through the full isolated gate.

## Known Remaining Work
1. Future provider work:
  - keep PTY marker completion and transcript callbacks as fallback behavior
2. End-to-end testing (HITL):
  - run real provider smoke tests through tiny repositories for Codex/Claude happy paths, resume behavior, execute loop stops, and HITL/AFK issue handling
