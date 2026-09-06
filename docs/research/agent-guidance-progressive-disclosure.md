# Progressive Disclosure Of Agent Guidance: Harness Mechanics And Reliability Evidence

## Executive Answer

The three harnesses Crucible's developer uses do not behave alike. Claude Code and OpenCode both load a subdirectory's `CLAUDE.md`/`AGENTS.md`
deterministically the moment the agent reads a file in that subtree — path-local guidance loaded "by proximity" is a real, harness-guaranteed
mechanism in both. Codex CLI does not: it concatenates `AGENTS.md` only from the project root down to its current working directory at turn start
and explicitly "does not walk past the project root" in either direction, so a file such as `src/harness/AGENTS.md` is invisible to Codex unless Codex
is launched with that directory as its cwd. Gemini CLI matches Claude Code and OpenCode with its own on-read "just-in-time" scan.

Separately, the one hard, first-party number on pointer-following reliability — Vercel's late-January-2026 eval — found that an optional,
model-triggered mechanism (Skills) was invoked in only 44% of cases by default (56% never-invoked) and topped out at 79% task-pass with heavy
explicit prompting, while the same knowledge inlined as an always-loaded 8KB index reached 100%. No first-party source measures degradation as a
specific function of pointer-chain hop count; the closest primary evidence is the general "Lost in the Middle" finding that context-window position,
not hop count, drives large recall swings. Crucible's plan is directionally sound but its root-to-baseline-to-focused-doc chain is exactly the kind
of model-triggered, prose-only pointer that Vercel's data says is unreliable — the plan is defensible only where the _last_ hop into safety-critical
content is deterministic (harness-loaded), not merely written as "before X, read Y."

## Scope And Method

This investigates loading mechanics for four harnesses and the evidence for how reliably agents follow prose pointer chains versus always-loaded
text, to inform Crucible's planned `docs/agents/` index plus path-local `AGENTS.md` files (tracked by
[`docs/agents/guidance.md`](https://github.com/DevFlow-HQ/devflow-cli/blob/main/docs/agents/guidance.md) and
[`docs/agents/engineering-baseline.md`](https://github.com/DevFlow-HQ/devflow-cli/blob/main/docs/agents/engineering-baseline.md)).

- Crucible today: root `AGENTS.md` is 23 lines with `CLAUDE.md` a real symlink to it; `engineering-baseline.md` fans out to eight focused docs
  (`module-design.md`, `dependencies.md`, `testing.md`, `validation.md`, `prototypes.md`, `refactoring.md`, `guidance.md`, `change-review.md`); no
  `src/harness/AGENTS.md` exists yet (only `src/adapters/` exists under `src/` today).
- Official docs were preferred over source; source was read when docs were silent or to pin exact numbers/line citations. Disagreements between a
  doc and source are called out explicitly.
- OpenCode evidence is pinned to the local checkout at commit
  [`1ead9e3d7f02661176fd46d7bcac7f6b7be3b52d`](https://github.com/anomalyco/opencode/tree/1ead9e3d7f02661176fd46d7bcac7f6b7be3b52d) — a materially
  different, Effect-rewritten codebase from the `38e10eb1...` commit cited in the earlier
  [OpenCode engineering-practices research](./opencode-engineering-practices.md); the instruction-loading logic itself changed between the two
  commits (see Finding 1c).
- Codex CLI evidence is pinned to a fresh clone of `openai/codex` at commit
  [`ac192cd7937b0d73edc6dffe009940ae53782dd4`](https://github.com/openai/codex/tree/ac192cd7937b0d73edc6dffe009940ae53782dd4) (cloned 2026-09-06).
- Claude Code and Gemini CLI are closed/hosted-docs products; their mechanics are drawn from the current published docs (accessed 2026-09-06), not a
  pinned source commit, because their implementation is not open source.
- All dates and access times are 2026-09-06 unless stated otherwise.

## Findings

### 1. Harness Loading Mechanics

#### 1a. Claude Code

Per [`code.claude.com/docs/en/memory`](https://code.claude.com/docs/en/memory) (accessed 2026-09-06):

- `CLAUDE.md` and `CLAUDE.local.md` load from the working directory **and every ancestor up to the filesystem root** at launch, concatenated
  root-first so the directory you launched from is read last. Root file order: managed policy → user `~/.claude/CLAUDE.md` → project
  `./CLAUDE.md`/`./.claude/CLAUDE.md` → `CLAUDE.local.md`.
- "Claude also discovers `CLAUDE.md` and `CLAUDE.local.md` files in subdirectories under your current working directory. Instead of loading them at
  launch, they are included when Claude reads files in those subdirectories." This is deterministic, harness-driven, on-read loading — exactly the
  "path-local file loaded by proximity" mechanic Crucible's plan assumes.
- `@path/to/import` expands eagerly at launch; imports "recursively import other files, with a maximum depth of four hops." Backticks keep a path
  literal instead of importing it.
- Size guidance: "target under 200 lines per CLAUDE.md file... Bloated CLAUDE.md files cause Claude to ignore your actual instructions." Claude Code
  loads a file up to 4 MiB and skips anything larger. Emphasis guidance: "If Claude keeps skipping one instruction, add emphasis such as 'IMPORTANT'
  to that line alone. If you emphasize many lines, none of them stands out" ([best-practices](https://code.claude.com/docs/en/best-practices)).
- `AGENTS.md`: "Claude Code reads `CLAUDE.md`, not `AGENTS.md`." The docs' own recommended bridge is `ln -s AGENTS.md CLAUDE.md` — the exact
  mechanism Crucible already uses — with an explicit caveat: "On Windows, creating a symlink requires Administrator privileges or Developer Mode, so
  use the `@AGENTS.md` import instead."
- `.claude/rules/*.md`: unscoped rules load at launch like `CLAUDE.md`; rules with `paths:` frontmatter "trigger when Claude reads files matching the
  pattern," another deterministic on-read mechanic, separate from skills.
- Confirmed from `git-scm.com` (`git config --help`, accessed 2026-09-06): `core.symlinks` "default is true, except `git clone` or `git init` will
  probe and set `core.symlinks` false if appropriate when the repository is created... If false, symbolic links are checked out as small plain files
  that contain the link text." This corroborates the Windows caveat above: on filesystems/checkouts where the probe disables symlinks, `CLAUDE.md`
  becomes a plain text file containing the literal string `AGENTS.md`, not a working alias — Claude Code would then load nothing.

#### 1b. Codex CLI (OpenAI)

Per `codex-rs/core/src/agents_md.rs` at commit `ac192cd7...` (module doc, lines 1–16):

> "We include the concatenation of all files found along the path from the project root to the current working directory... 1. Determine the
> project root by walking upwards from the current working directory until a configured `project_root_markers` entry is found... (default `.git`)... 2. Collect every `AGENTS.md` found from the project root down to the current working directory (inclusive) and concatenate their contents in that
> order. 3. We do **not** walk past the project root."

Key facts, all from the same commit:

- No below-cwd traversal exists anywhere in this loading path: `load_project_instructions` (lines 55–80) builds the file list once from
  `environments.turn_environments()` at turn assembly, walking root→cwd only. There is no code path that rescans a file's own directory when Codex
  reads that file, unlike Claude Code, OpenCode, or Gemini CLI. A nested `src/harness/AGENTS.md` is invisible to Codex unless Codex's cwd is at or
  below `src/harness/`.
- `AGENTS.override.md` is real and takes precedence: `pub const LOCAL_AGENTS_MD_FILENAME: &str = "AGENTS.override.md"` (line 42), confirmed by a
  runtime test at `codex-rs/core/src/agents_md_tests.rs:1537`, "`AGENTS.override.md` is preferred over `AGENTS.md` when both are present."
- Default budget: `pub const DEFAULT_PROJECT_DOC_MAX_BYTES: usize = 32 * 1024` (`codex-rs/config/src/config_toml.rs:73`) — 32 KiB, confirmed in
  source, matching the value context7 initially reported. `project_doc_max_bytes` caps only concatenated project `AGENTS.md` content; the global
  `~/.codex/AGENTS.md`-style user instructions are passed separately and are never budget-capped (`agents_md.rs:60–65`).
- **Doc/source disagreement**: `codex-rs/core/src/models-manager/prompt.md` (a prompt template shown to the model, not runtime logic) tells the model
  "more deeply nested AGENTS.md files take precedence in case of conflicts" — phrased as if arbitrary subdirectory nesting is discovered. The actual
  discovery code contradicts this: only files on the root→cwd path are ever loaded, so "more deeply nested" in practice means only "closer to cwd
  within the root→cwd chain," not "in a subdirectory the agent later visits." Trust the source over this prompt-template wording.
- `openai/codex` itself has only 2 `AGENTS.md` files in the whole repo (root, 322 lines; one nested 3 levels down at
  `codex-rs/tui/src/bottom_pane/AGENTS.md`) — Codex's own team does not lean on a deep hierarchy, consistent with the mechanic above making deep
  nesting largely inert for their own default invocation pattern (cwd = repo root).

#### 1c. OpenCode

Per the local checkout at commit `1ead9e3d7f02661176fd46d7bcac7f6b7be3b52d`:

- Startup ("system") load, `packages/opencode/src/session/instruction.ts:110–133` (`systemPaths`): candidate filenames are
  `["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]` (lines 64–68, `CLAUDE.md` gated by a `disableClaudeCodePrompt` flag; `CONTEXT.md` marked deprecated).
  For the project level it calls `fs.findUp(file, ctx.directory, ctx.worktree)` and takes **only the first filename that matches at all** —
  "The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor" (line 122). This differs from Claude Code: OpenCode
  loads one nearest ancestor file at startup, not the full ancestor chain concatenated.
- On-read nested loading, `instruction.ts:171–221` (`find`/`resolve`): given a file path Claude just read, `resolve` walks
  `current = path.dirname(target)` upward to the worktree root, calling `find(current)` at each level, and attaches any newly-found instruction file
  "once per message" via a `claims` map keyed by message ID (comment at line 193: "Walk upward from the file being read and attach nearby instruction
  files once per message"). This is the same deterministic path-local mechanic as Claude Code's subdirectory `CLAUDE.md`, and it is what Crucible's
  planned `src/harness/AGENTS.md` would rely on in OpenCode.
- Skills, `packages/opencode/src/session/system.ts:105–117` and `packages/core/src/tool/skill.ts`: the system prompt always includes
  `Skill.fmt(list, { verbose: true })` — names and descriptions only — plus "Use the skill tool to load a skill when a task matches its description."
  Full `SKILL.md` body content is injected only when the model calls the `skill` tool (`skill.ts:35–52`, `toModelOutput`), which reads the file from
  disk at call time. Metadata-always / body-on-invocation matches Anthropic's Level 1 / Level 2 split exactly (Finding 2b).
- OpenCode's own repo has 18 nested `AGENTS.md` files, root 161 lines, ranging 1–321 lines, up to 3 directories deep (e.g.
  `packages/opencode/src/session/llm/AGENTS.md`, 90 lines) — see Finding 3.

#### 1d. Gemini CLI (brief, comparison only)

Per [`docs/cli/gemini-md.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md) and
[`docs/reference/configuration.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md) (main branch, accessed
2026-09-06, doc pages only — no source commit pinned):

- Three tiers, concatenated: global `~/.gemini/GEMINI.md`; workspace/ancestor context files at the project root and its parents; and
  **just-in-time (JIT) context files** — "When a tool accesses a file or directory, the CLI automatically scans for `GEMINI.md` files in that
  directory and its ancestors up to a trusted root." This is a third harness with deterministic on-read nested loading, same category as Claude Code
  and OpenCode.
- `context.discoveryMaxDirs` (default reported as 200) bounds how many directories the JIT scan traverses; `context.memoryBoundaryMarkers` (default
  `[".git"]`) sets the upward-traversal stop point.
- `contextFileName` accepts a string or array (docs show `["AGENTS.md", "CONTEXT.md", "GEMINI.md"]`), so Gemini CLI can be pointed at the same
  `AGENTS.md` Crucible already ships.
- `@file.md` imports exist; the docs do not state a maximum recursion depth (unlike Claude Code's stated 4-hop limit) — treat depth as unverified for
  Gemini CLI.

#### 1e. Comparison Table

| Harness     | Root/global file(s)                                               | Ancestor chain at start                                    | Nested subdir file on read?                                     | Import mechanism                                   | Size cap                                             | Symlink OK?                                                                            |
| ----------- | ----------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Claude Code | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`                  | Full concatenation, root-first, all ancestors              | **Yes** — deterministic, on file read                           | `@path`, max 4 hops                                | ~200 lines target; 4 MiB hard skip                   | Yes; breaks silently if `core.symlinks=false` (common default probe result on Windows) |
| Codex CLI   | `AGENTS.md` (+ `AGENTS.override.md`), global `~/.codex/AGENTS.md` | Root→cwd only, concatenated in that order; never below cwd | **No** — no on-read rescan exists                               | None found in source                               | 32 KiB (`project_doc_max_bytes`), global file exempt | Not documented; untested here                                                          |
| OpenCode    | `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` (first match)                | **Nearest single ancestor only**, not full chain           | **Yes** — deterministic, once per message                       | None found for instructions (skills use file tool) | None found                                           | Not documented; untested here                                                          |
| Gemini CLI  | `GEMINI.md` (or configured `contextFileName`)                     | Full ancestor chain to trusted root                        | **Yes** — JIT scan, bounded by `discoveryMaxDirs` (default 200) | `@file.md`, depth limit not documented             | Not documented                                       | Not documented; untested here                                                          |

### 2. Evidence On Pointer-Chain Reliability

#### 2a. Vercel: AGENTS.md vs Skills eval

Per [Vercel's blog post](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) (Jude Gao, published 2026-01-27, accessed
2026-09-06):

- Final task pass rates: baseline with no docs 53%; Skills with default triggering 53% (+0pp); Skills with explicit "invoke this skill" instructions
  79% (+26pp); an always-loaded `AGENTS.md` index 100% (+47pp).
- Invocation failure: "in 56% of eval cases, the skill was never invoked" by default — roughly 44% default invocation rate. Adding explicit
  instructions raised invocation to "95%+" but pass rate still capped at 79%, below the always-loaded index's 100%.
- The `AGENTS.md` index used was compressed to "around 8KB (an 80% reduction)" from an initial 40KB naive injection — i.e., the winning approach was
  not "dump everything," it was a compact always-loaded index.
- Wording sensitivity: different explicit-instruction phrasings produced large behavioral swings — an "invoke first" phrasing caused the agent to
  miss a required file change it caught under an "explore first" phrasing. Vercel's own framing: "small wording tweaks produce large behavioral
  swings."
- This is the strongest first-party evidence found that a model-triggered, optional-load mechanism is materially less reliable than always-loaded
  text, and it is specific to Skills, not to nested `AGENTS.md`/`CLAUDE.md` files (which, per Finding 1, are harness-triggered by file access, not
  model-triggered).

#### 2b. Anthropic: Agent Skills progressive disclosure

Per [`platform.claude.com/.../agent-skills/overview`](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) (accessed
2026-09-06): three levels — **Level 1 metadata** (`name`+`description` YAML frontmatter, "always loaded... at startup," ~100 tokens/skill), **Level 2
instructions** (`SKILL.md` body, loaded only "when Skill is triggered," "under 5k tokens" target), **Level 3+ resources** (bundled files/scripts,
"None until accessed"). The `description` field is explicitly "what Claude matches your request against when determining whether to trigger the
Skill" — i.e., trigger is model judgment against a natural-language description, the same probabilistic mechanism Vercel measured failing 56% of the
time by default.

Per [Claude Code best-practices](https://code.claude.com/docs/en/best-practices) (accessed 2026-09-06): "CLAUDE.md is loaded every session, so only
include things that apply broadly. For domain knowledge or workflows that are only relevant sometimes, use skills instead." And: "If Claude keeps
skipping one instruction, add emphasis such as 'IMPORTANT' to that line alone. If you emphasize many lines, none of them stands out." No specific
"IMPORTANT/YOU MUST" hop-count claim was found in this post beyond that single-instruction guidance.

#### 2c. agents.md spec

Per [`agents.md`](https://agents.md/) (accessed 2026-09-06): "Place another AGENTS.md inside each package. Agents automatically read the nearest file
in the directory tree, so the closest one takes precedence." This "closest file wins" precedence is the shared convention the spec promotes; it is
consistent with Codex's root→cwd behavior and with Claude Code's/OpenCode's/Gemini CLI's on-read nesting, but the spec site does not itself
guarantee any specific harness scans below cwd — that is harness-specific (Finding 1). The site cites "the OpenAI repository" as containing 88
`AGENTS.md` files as a monorepo example; this could not be verified against `openai/codex` (which has only 2) and is presumably a different,
non-public OpenAI monorepo — **unverified**.

#### 2d. Instruction-count / long-context degradation research

The one primary, peer-reviewed source found on context-position effects is Liu et al., ["Lost in the Middle: How Language Models Use Long
Contexts"](https://arxiv.org/abs/2307.03172) (Stanford/UW, TACL 2024): relevant-information recall is highest at the start or end of a long context
and "can degrade by more than 30%" when the same information moves to the middle, producing a U-shaped performance curve. This is evidence about
**position**, not about **hop count in a pointer chain**, and it was not run against agentic coding harnesses specifically — treat it as directionally
relevant background, not a direct measurement of Crucible's pointer-chain design.

**No first-party or credible measured source was found stating agents reliably follow only "N hops" of pointers.** The developer's claim that "agents
reliably follow only a few layers of pointers" should be treated as anecdotal/unverified until Crucible runs its own representative-task walk
(Finding 4). The closest indirect evidence is Vercel's finding that even a single optional hop (invoking one Skill) already fails 56% of the time by
default — which suggests the risk is concentrated at the "will the agent choose to take a pointer at all" step, not specifically at chain depth.

### 3. Examples Of Hierarchical AGENTS.md/CLAUDE.md In Practice

- **OpenCode** (commit `1ead9e3d7f02661176fd46d7bcac7f6b7be3b52d`): 18 `AGENTS.md` files, root 161 lines, depth up to 3 directories
  (`packages/opencode/src/session/llm/AGENTS.md`, 90 lines), sizes ranging from 1 line (`packages/stats/AGENTS.md`) to 321 lines
  (`packages/llm/AGENTS.md`). Loading mechanics for this hierarchy are exactly Finding 1c: one nearest file loaded at start, others loaded on read.
- **openai/codex** (commit `ac192cd7937b0d73edc6dffe009940ae53782dd4`): only 2 `AGENTS.md` files — root (322 lines) and one 3 levels deep
  (`codex-rs/tui/src/bottom_pane/AGENTS.md`). Consistent with Finding 1b: because Codex's own discovery mechanic does not scan below cwd, a deep
  hierarchy buys the Codex team little when cwd defaults to the repo root, so they mostly don't build one.
- **A large OpenAI monorepo cited by agents.md** ("88 AGENTS.md files"): could not be independently verified; **unverified**, likely not
  `openai/codex`.

## Synthesis For Crucible (Inference, Not Findings)

The following is judgment applied to Findings 1–3, not new evidence.

- **Path-local `AGENTS.md` by proximity is deterministic in Claude Code, OpenCode, and Gemini CLI, but not in Codex CLI.** A file such as
  `src/harness/AGENTS.md` will reliably reach context in the first three harnesses whenever the agent reads a file under `src/harness/`. In Codex
  CLI it will only be seen if Codex is invoked with a cwd at or below `src/harness/` — which is not this developer's typical workflow (Codex is
  normally launched from the repo root). Treat Codex CLI as **not receiving path-local guidance** for planning purposes unless Crucible separately
  verifies its own invocation pattern changes cwd per module.
- **Prose "Before changing X, read Y.md" pointers are a model-triggered mechanism, structurally identical to what Vercel measured failing.** They are
  not harness-guaranteed like an ancestor-chain file or an on-read nested file — the agent must recognize the trigger condition and choose to issue a
  Read call. Crucible's current chain (root → `engineering-baseline.md` → 8 focused docs, each themselves able to point further per
  `guidance.md`) is exactly this category at every hop past the always-loaded root. Given Vercel's numbers, the safest reading is: **the first hop
  out of the always-loaded root is the one most likely to be skipped**, since it depends on the agent both reading the root text and choosing to act
  on a specific line among many. Depth beyond that first hop has no measured degradation number to cite — only the general position-based backdrop
  from Finding 2d.
- **What follows from this:** safety-critical, cross-cutting rules (the "mandatory kernel" language already in `engineering-baseline.md`) should not
  depend solely on the agent voluntarily reading a linked doc; where a rule is truly non-negotiable, prefer making its _trigger_ deterministic (a
  path-local file the harness loads on read, or inlining the rule directly in the always-loaded root) over a purely prose pointer, in harnesses where
  path-local loading exists. Where it doesn't (Codex CLI), the root/baseline text is the only reliable carrier, which argues for keeping Codex-visible
  safety rules inline near the root rather than behind any pointer.
- **Keep inline:** anything that must apply regardless of harness or cwd — this favors Crucible's existing instinct (root `AGENTS.md` under 25 lines,
  `engineering-baseline.md` as a "mandatory kernel") matching Claude Code's own <200-line guidance and Anthropic's SKILL.md <5k-token guidance for
  what's allowed to be conditional.
- **How to measure:** Crucible has no evidence yet, only mechanics and one third-party eval on a different task shape. `docs/agents/guidance.md`
  already prescribes "follow the affected pointer chain recursively once with a representative task" — that one-shot manual walk is the only
  currently-planned check. Consider extending it into a small periodic eval modeled on Vercel's method (representative task, with/without the
  pointer present, measured pass rate) rather than trusting a single manual walk indefinitely, since Vercel's own data shows small wording changes
  swing outcomes by tens of points.

## Open Questions

- Does Crucible's actual Codex CLI invocation pattern ever change cwd into a subdirectory (e.g., via a wrapper script), which would make Codex's
  root→cwd chain include path-local files after all? Unverified from this research; needs checking against however DevFlow's own harness adapters
  invoke Codex.
- Is there a way to make a `docs/agents/*.md` pointer deterministic rather than prose-triggered inside a single-package repo (no natural per-module
  subdirectory yet exists under `src/` besides `src/adapters/`), short of waiting for `src/harness/` and similar module roots to exist?
- Should Crucible run its own small Vercel-style eval before committing to a specific pointer depth, given that the only hard reliability numbers
  found are from a different (Next.js/skills) task shape and may not transfer?
- Is the Windows `core.symlinks` risk to `CLAUDE.md` worth mitigating now (e.g., an `@AGENTS.md` import as Claude Code's docs suggest) or deferred
  until Crucible has a confirmed Windows contributor?

## Gist

Claude Code, OpenCode, and Gemini CLI all load a subdirectory's guidance file deterministically the moment a file in that subtree is read; Codex CLI
does not walk below its current working directory at all, so path-local `AGENTS.md` files are effectively inert for Codex unless its cwd is inside
that subtree. The only hard first-party number on pointer reliability (Vercel, Jan 2026) shows a model-triggered mechanism failing to invoke in 56%
of default cases and topping out at 79% pass rate even with heavy explicit prompting, versus 100% for an always-loaded compact index — evidence that
argues for keeping safety-critical rules inline or behind a deterministic (harness-loaded) trigger rather than a prose-only pointer, especially past
the first hop out of the always-loaded root. No credible source quantifies degradation specifically by pointer-chain hop count; treat any specific
"N hops" claim as unverified until Crucible runs its own representative-task walk.
