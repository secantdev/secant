# Recorded Harness fixtures

Byte-faithful recordings of a real installed Harness, replayed in CI so the
Adapter is exercised against exactly what it saw once — never a fake in place of
a spawn (ADR 0027). The `claude` replayer (`../replayer.mjs`) reads these; the
guidance-structure suite (`tests/architecture/check-guidance-structure.ts`)
fails any case directory missing its `recording.json`.

## Layout

```
fixtures/<harness>/<case>/
  recording.json    provenance sidecar (six required keys, below)
  case.json         replay script the replayer executes
  *.stdout          byte-faithful stdout chunks case.json references
  *.stderr          optional byte-faithful stderr chunks
  workspace.patch   optional git diff the replayer applies at the Turn's result
```

## `recording.json` (sidecar)

Six keys, all required (the guidance-structure suite enforces their presence):

- `harness` — e.g. `"claude-code"`.
- `executableVersion` — full `claude --version` string at record time.
- `protocolVersion` — `claude_code_version` reported in the init frame.
- `recordedAt` — ISO-8601 instant, or `"synthetic"` for a hand-authored case.
- `redactions` — array of `{ "placeholder", "reason" }`, one per substitution class
  the recorder applied (home directory, user name, bridge token, credential).
- `refreshCommand` — the opt-in command that re-records this case, or a
  `"synthetic — ..."` note for hand-authored cases.

## `case.json` (replay script)

- `exitCode` — the process exit code the replayer settles with.
- `turns[]` — one entry per stdin Turn frame the Adapter sends:
  - `stdout` / `stderr` — a byte file emitted for the whole Turn, **or**
  - `steps[]` — an ordered mix of `{ "emit": "file" }` (stdout bytes) and
    `{ "bridge": { tool_name, input } }` / `{ "bridgeAll": [ ... ] }` (a real MCP
    permission round-trip that blocks until Secant answers), so recorded stdout
    after a bridge step emits only once the verdict is in.
  - `workspacePatch` — a git diff file the replayer `git apply`s in the launch
    cwd as the Turn concludes (the "applied at the Turn's result" step).
  - `exitAfter` — exit right after this Turn's bytes (models lost/corruption).
  - `ignoreSigterm` — swallow SIGTERM so only a force-kill stops the process.
- `resume` — a separate `{ exitCode, turns }` played when the launch carries
  `--resume` (a reattached, detached Session).

Session ids are **not** redacted: Secant mints the session UUID and passes it at
spawn, so each recording is made with the canonical per-case UUID its tests use,
and the recorded frames echo it verbatim. The bridge bearer token never appears
in stdout (it rides only in `--mcp-config` argv); the recorder still scans for it.

## Recording (opt-in, local, needs the installed Harness)

`bun tests/harness/record.ts <case>` drives the named scenario against the
installed `claude`, reproducing the Adapter's exact launch argv and an equivalent
loopback MCP approve-bridge, then writes the case directory. It records with
`--restricted` (the real login and model apply, but this host's hooks, plugins,
`CLAUDE.md`, and settings-file MCP do not) so fixtures are clean and reproducible;
scoping `CLAUDE_CONFIG_DIR` instead would drop the login. It never runs in CI.

The recorder refuses to write a recording whose bytes still match a credential
pattern after redaction, naming the pattern — a recording must not carry a live
secret.

## Synthetic cases

Some Adapter behaviours a real `claude` cannot be made to emit on demand:
`error_max_budget_usd` failure, an init-less process, a SIGTERM-swallowing
process, a mid-frame exit, queued multi-Turn budget failure, and the specific
concurrent/outstanding permission-bridge shapes. These stay hand-authored, moved
into this tree with a `recording.json` whose `recordedAt` is `"synthetic"` and
whose `refreshCommand` explains why. They preserve the coverage the deleted
`protocol-cases/` tree carried.

**Re-evaluate later:** if a future `claude` gains a deterministic way to induce
any of these (a fault-injection flag, a `--max-budget`, a documented corruption
mode), promote that case from synthetic to a real recording and delete its
synthetic note. The synthetic inventory below is the pick-up list.

| Case                     | Behaviour                                                                                                                        | Why synthetic                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `failed`                 | terminal `error_during_execution` result                                                                                         | no on-demand way to force a task error result                 |
| `two-turns`              | two Turns, second `error_max_budget_usd`                                                                                         | no on-demand budget-exhaustion trigger                        |
| `no-init`                | process never emits init                                                                                                         | no way to make a real init hang deterministically             |
| `unresponsive`           | swallows SIGTERM → force-kill, reported escalated (every OS; on Windows every live child is force-killed and reported escalated) | a real `claude` honours SIGTERM                               |
| `lost-completion`        | exits mid-stream with no result                                                                                                  | timing-dependent; kept deterministic as synthetic             |
| `approval`               | one Bash approval, allow/deny/expired                                                                                            | real tool inputs vary run to run                              |
| `approval-concurrent`    | two coexisting approvals                                                                                                         | real runs raise one prompt at a time                          |
| `approval-outstanding`   | an approval left outstanding at close                                                                                            | timing-dependent                                              |
| `resume-unacknowledged`  | resume init echoes a different id                                                                                                | a real `--resume` acknowledges the id                         |
| `completed`              | success Turn: tool activity, thinking/telemetry exclusion, preview coalescing, unknown-frame tolerance                           | a real plain Turn does not emit every frame variety on demand |
| `completed-quotes-login` | success result whose text quotes "run /login"                                                                                    | guards that a real answer is not misread as auth              |
