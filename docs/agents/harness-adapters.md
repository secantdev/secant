# Harness Adapter Internals

Read this before changing the private internals of the Claude Code or Codex Adapter under `src/harness/`. The Harness Interface, terminal ordering,
interrupt, recovery, and test invariants every Adapter shares stay in [the Harness Module's notes](../../src/harness/AGENTS.md).

## Claude Code Adapter

- Qualification is cached per Adapter instance in a private `Map`, keyed by the discovered target's discovery source, its path, and its file identity: same
  path with identical bytes ⇒ the probed version cannot have changed, so the cached profile is reused without re-running `--version`; any drift in path or
  identity requalifies, and folding the source into the key stops a reused profile reporting a stale source.
- The permission bridge mints a 256-bit per-Run bearer token for its loopback MCP server; the token lives only in the `--mcp-config` argv and the server's
  constant-time auth check. The Session holds the bridge's `redactSecret` from launch and routes every failure cause originating below launch through it
  (`scrub` on each close observation; the stdin-write and stdout-read errors and the captured stderr text too), so the rule is "redact at the Seam",
  not one spawn-error path (#127 A22).
- The stream-json protocol model is the private `claude-code/frames.ts`: one `zod` schema per known frame type (`init`, `assistant`, `user`,
  `stream_event`, `result`, `telemetry`), parsed per frame by `parseFrame`, with the pure readers and the only raw-field accessors. Only the fields dispatch
  iterates over are structurally required (a message's content array, a stream event's object; a `result` always settles, a missing `subtype` as
  `unknown-result`); every other field degrades to absent (`.catch(undefined)`), unknown fields pass through, and a known type whose
  parse fails or an unknown type is generic activity — never protocol corruption. `claude-code.ts` dispatches on `ParsedFrame` and reads no raw field.
- `OwnedProcess.writeStdin` resolves only after both the write callback has fired without error and the stream has drained (it waits for the `drain` event
  when `write` returned `false`); an error rejects. The Turn's bytes are accepted before the write promise settles, which is what the durable-admission
  ordering rests on.
- `jsonl.ts` is the one private hand-rolled NDJSON splitter both native Adapters use (M3 D15, M4 D1): it splits on `\n`, strips a trailing `\r`, preserves
  the terminated raw line for recording, and distinguishes a final unterminated remainder. Claude JSON-parses only a line that trims to something starting
  with `{`; its recorded protocol-corruption fixture pins such a remainder as `truncated JSON frame`, while Codex rejects any nonblank remainder.
- `acceptInit` compares the native `session_id` to the minted coordinate. A mismatch on a **resume** is a `recovery`-phase `recovery-unacknowledged` failure
  that marks the Session unusable (never a silent fresh conversation); a mismatch on a **fresh launch** is `not-started`/`init-session` — the minted id was
  simply never echoed, so the Turn never started.
- Authentication is recognized from the stdout `result` frame, since print mode has no typed auth field. #115's recording pinned the not-logged-in signal
  as `subtype:"success"` with `is_error:true` and `result:"Not logged in · Please run /login"`, so the check runs before the success branch, but the guard
  fires only when `isAuthenticationResult(frame)` and (`subtype !== "success"` or `is_error === true`): a real answer whose text merely quotes a login phrase
  settles `is_error:false` and stays a completed Turn. The raw result never crosses the Seam (it may quote a key) — only `AUTHENTICATION_REQUIRED` does.
- Session child reuse: a Turn result may settle before the child emits `close`. The Session tracks which Turn owns the child, lets an already-settled close
  win before the next send, and never attributes an old child's close to the next Turn; a still-live child may accept the next Turn in place.
- Interruption uses the process Module's `interrupt(gracefulMs)`, which reports whether a forced escalation was needed: a graceful stop settles
  `interrupted`, a force-kill `lost`, so a live Claude Code on Windows is force-killed at once and every Windows interrupt of a live Turn settles `lost`.
  `onClosed` yields to an in-flight interrupt so the two never race the result: a confirmed interrupt claims the process before awaiting, and `onClosed`
  returns early when `this.process !== owned`, leaving the interrupt to settle the one authoritative result.
- Resume spawns with `--resume` (never a fresh `--session-id`) for a relaunch of a Session that already ran or any Turn carrying `resume`. Init state is
  per process.
- Session unusability is stored as a private `unusableReason` on the Session, set by `markUnusable` when a resume is not acknowledged; the Turn-start path
  (`submit`) reads it first and fails every further Turn with the same recovery failure, never opening a fresh conversation.

## Codex qualification and Turns

- `codex.ts` owns orchestration, cache, and profile; `codex/qualification.ts` owns bounded pre-thread validation and diagnostics; `codex/runtime-protocol.ts`
  owns retained JSONL state and normalization; `codex/required-schema.ts` owns generated-schema compatibility. Native protocol types stay private.
- Every `prepare` observes `codex --version`; cached schema evidence is keyed by discovery source, path, SHA-256 identity, version, platform, and revision.
  The host platform driving discovery/profile is immutable; only the cache-key test seam varies platform evidence. A hit skips schema generation only.
- Live qualification sends one `initialize` then `initialized`, runs bounded `account/read` and `model/list`, and transfers its child and connection.
- A fresh Session gets `thread.id` before admission; a detached Session requires its exact `thread/resume` id. Any bad acknowledgement makes it `unusable`; no fallback.
- Fresh and resumed Turns preserve admission-before-content and matching terminal authority; completed items supersede delta previews.
- Codex client RPC and reverse-request ids have separate private maps. Approvals expose exact actions; native resolution or terminal expiry wins late answers.
- Native Steer and Interrupt await bounded RPC acknowledgement for exact active ids. Only matching interrupted completion proves interruption; connection loss stays `lost`.
- `CodexTurn` keeps approval correlation and native control together because both share terminal-ordering state. A third Harness needing the same shapes
  triggers their split; before then, splitting only relocates coupling.
- Codex close rejects new work, expires requests, attempts bounded native interruption, closes stdin, and reaps the tree; cleanup cannot rewrite Turn truth.
- Timeout split: `handshakeTimeoutMs` bounds only the one-off `prepare` qualification (spawn → `initialize`/`account`/`model`); `controlTimeoutMs`
  (defaults to it) bounds post-qualification live exchanges (session start/resume, Turn start/interrupt/steer acks). A stall-then-timeout test squeezes
  `controlTimeoutMs`, never `handshakeTimeoutMs` — throttling the spawn+handshake there flakes `prepare` on a loaded Windows runner (the #148 CI flake).
- Codex inherits user environment/home; unauthenticated becomes the fixed separate-login remediation, and no account or credential crosses the Seam.
