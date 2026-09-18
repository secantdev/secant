# Adopt OpenCode's Presentation Layer as a Pinned Reduced Vendor Behind Two Crucible-Owned Ports

Crucible reuses OpenCode's TUI, but only its **presentation half**, and only as a pinned copy that becomes Crucible's own code. The [extraction
research](../research/opencode-tui-extraction-constraints.md) established that OpenCode's renderer configuration, Solid composition, layout
primitives, keymap mechanics, dialogs, transcript layout, themes, and generic presentation utilities are genuinely reusable, while its application
shell, state projections, commands, and routes are welded to OpenCode's SDK types, event vocabulary, and Bun runtime. We take the first group as a
reduced vendored copy and **rebuild** the second against a Crucible-owned Port — `SDKProvider`, `SyncProvider`, `DataProvider`, `ProjectProvider`,
OpenCode's routes and commands, provider authentication, MCP/LSP/VCS status, upgrade UI, Workspace management, and plugin installation are replaced
outright, and none of their source crosses. OpenTUI itself is **not** vendored: it stays a real npm dependency pinned at `0.4.5`, unpatched and
unforked, because [the cross-platform prototype](https://github.com/DevFlow-HQ/devflow-cli/issues/6) proved that exact version starts, renders,
accepts input, resizes, restores the terminal on every exit path, and packages on Windows, macOS, and Linux. We rejected consuming
`@opencode-ai/tui` as a package (private, source-exported, workspace-coupled, no external contract), a compatibility facade over the OpenCode SDK
(requires emulating a large OpenCode domain surface Crucible does not want), a full fork with an upstream remote (buys auditable merges that a
copy-once policy never uses), and rebuilding presentation from scratch (discards genuinely generic work for no gain).

Two Seams carry the boundary, and they do different jobs. The **Projection Port** sits above the state layer: Crucible pushes a normalized snapshot
and incremental events down to the view components, and commands travel back up. It is a plain in-memory Interface — function calls and callbacks,
with no JSON, no sockets, and no serialization assumptions — so that whether the TUI shares a process with the Run engine or talks to it over a pipe
stays a separate decision rather than one this ADR pre-empts; if a separate process is chosen later, the Port becomes the thing an adapter implements
over that pipe. Harness selection sits above the Projection Port, and changing it remounts the session subtree rather than mutating it in place. The
**Renderer Port** sits around OpenTUI and is narrowed to lifecycle only — `size`, `onKey`, `onResize`, `destroy`, and `destroyed`. It carries forward
the prototype's seam minus its `render(view)` method, which painted a flat list of lines and has no production use because view components render
through OpenTUI's Solid integration directly. The Port's value was never drawing: it is that teardown is exercisable against a fake with no terminal,
which is what makes the invariant below testable at all.

Three extraction rules apply to every file copied. Vendored source is **runtime-neutral by construction**: no `Bun.*` call and no `bun:*` import
survives the copy, with `Bun.stringWidth` and `Bun.file` the realistic cases, so that the runtime and packaging decision stays genuinely open rather
than quietly forced by what we pasted in. Crucible **never speaks OpenCode's vocabulary** — no `@opencode-ai/*` import, no OpenCode event name, no
OpenCode SDK call, no OpenCode domain type. What the canonical gate's structural check actually enforces is the **import specifier** — no `@opencode-ai/*`
import (`tests/architecture/module-policy.ts`) — the load-bearing case, since importing an OpenCode domain type means importing the package; the
event-name, SDK-call, and domain-type prohibitions are standing policy the check does not mechanically detect. Enforcing the import by check rather than
review matters because the extraction research already classifies core flows importing OpenCode domain types as grounds to abandon adoption entirely, and
a condition that severe must not depend on who reviews the pull request. Finally, **no dead UI**: features Crucible does not have, such as OpenCode's model picker, provider
login, MCP/LSP status, upgrade prompt, workspace management, and plugin slots, are deleted at copy time rather than hidden behind a flag or left
visible as no-ops, since hidden code still has to be read on every upstream review and still has to be ported off Bun APIs, while a visible no-op is a
bad user experience by construction. Because files are copied by hand, not copying is the cheapest available action. The standing rule that keeps it
that way is that every button, key binding, and menu entry has a real command behind it in the Projection Port, so a screen dispatching a command
nobody implemented fails to compile. Extraction is ongoing rather than one-shot: build features when they are needed, but check whether OpenCode has
already solved a problem before reinventing it, and read OpenCode's state providers as a quality reference when designing Crucible's own, recording
where we deliberately diverge.

Crucible owns one lifecycle invariant that OpenTUI's defect forces on it. Measurement in
[#33](https://github.com/DevFlow-HQ/devflow-cli/issues/33#issuecomment-5359398258) established that `createCliRenderer` instantiates `process.stdin`
and `destroy()` leaves that handle open and registered on the event loop; on the legacy Windows console host, the console wedges when a keypress was
delivered during the session **and** the loop turns before process exit. Crucible's shutdown path therefore releases `process.stdin` — listeners off,
`setRawMode(false)`, `pause()`, `unref()`, `destroy()` — **before** calling `renderer.destroy()`. An earlier, stricter reading requiring synchronous
teardown with no event-loop work after `destroy()` does not apply and is superseded, so `await`, timeouts, and `Promise.race` remain available. A test
fails if the ordering is reversed, and the teardown site carries a comment pointing at the upstream report, because that is the one place a future
reader will be tempted to tidy the ordering away. Legacy conhost stays a supported host: surrendering a real user segment over a defect with a
five-line workaround was priced as the worst-value option. The defect belongs upstream and a one-line report is to be filed against `anomalyco/opentui`
— _`destroy()` leaves the `process.stdin` handle `createCliRenderer` created registered on the event loop; on legacy conhost any subsequent loop turn
wedges the console host_ — and is filed as <https://github.com/anomalyco/opentui/issues/1405>. Re-measurement against `0.5.6` on Windows 11 conhost
confirmed the defect survives the version bump and that the workaround holds, but only on Node: under Bun `1.3.14` the same release leaves
`process.stdin` fully `destroyed` and the console dies anyway, so adopting Bun later would forfeit legacy conhost support until someone finds a
Bun-side release. Crucible ships the workaround regardless and does not wait for a fix. Because
CI structurally cannot observe this (a pty master is not a real terminal, and ConPTY is a screen scraper that has already produced false readings in
both directions), the human-run real-console check is a **release gate**, re-run on every OpenTUI bump.

Crucible owns its dependency pin rather than mirroring OpenCode's lockfile. The extraction research's "pin Bun, OpenTUI, Solid, Effect, and natives as
one tested set" rule existed to keep merges of OpenCode component code viable; under a copy-once-and-rebuild policy that lockfile stops being
load-bearing, and OpenCode sitting on `0.4.5` with eight open reports of this same console defect is precisely the case where following upstream costs
and buys nothing. This is not a decision to upgrade: `0.5.x` does not fix the defect and brings a larger native library plus new image and audio
surface. Version bumps, and the breakage each drags in, are their own tickets. Upstream review is **event-triggered rather than scheduled** — look at
OpenCode when Crucible actually wants a feature, and at OpenTUI when a release names a lifecycle, Windows, or console fix — because reviewing a
copied-once subset on a calendar is busywork. The inventory lives in a top-level `UPSTREAM` record created by the first extraction commit and updated
by every one after it, recording for each copied path the OpenCode commit it came from, the local modifications applied, and the date; it is a living
document precisely because extraction is ongoing. Testing responsibilities split four ways, three of them obligations: Projection Port contract tests
over fake snapshots and events, renderer frame tests over OpenTUI's in-memory renderer, and a deliberately small real-PTY lifecycle suite. Presentation
snapshot tests are optional, because they fail on deliberate changes as readily as accidental ones while the first two layers already cover ordering
and dispatch.

The 33 themes shipped in OpenCode's TUI are taken, attributed, and pruned. Verified against the OpenCode tree at `1ead9e3d7f` (the commit the `UPSTREAM`
record pins; this ADR first cited `2cba7e22`, which disagrees with every other record), not one carries any
attribution — `license`, `author`, `credit`, `copyright`, and `source` return no matches across the set — and the palettes are the genuine upstream
values rather than reinterpretations, with Nord carrying `#2e3440`, `#88c0d0`, `#bf616a`, `#a3be8c` and Gruvbox carrying `#282828`, `#ebdbb2`,
`#fb4934`, `#b8bb26`. This is real third-party work, but the obligation is far smaller than a per-file provenance audit: most are well-known
MIT-licensed community themes needing one notice line each. Material and Monokai warrant an individual licence check, and Cursor, Vercel, and GitHub
raise a naming question rather than a copyright one — shipping a theme named for another company's product inside a competing tool — so those five are
dropped and the rest attributed. The remaining attribution obligations stand as the research wrote them: MIT notices for OpenCode and OpenTUI in a
shipped third-party notices file, the BSD-3-Clause notice for `diff` if it survives into the artifact, and — in place of a locked licence inventory
generated from the real artifact — the third-party notices cross-check that [#128](https://github.com/secantdev/secant/issues/128) adds against
`THIRD-PARTY-NOTICES.md`. Taking the themes does **not** make Crucible accessible: the theme schema bakes green and red into `success`/`error` and
`diffAdded`/`diffRemoved`, so no theme choice makes the TUI legible to colourblind users and the fix is that the UI never signals state by colour alone.
That belongs to the command and projection interface, not here. Finally, the trade this ADR consciously accepts: because the presentation subset is
copied rather than depended upon, upstream can never break it — and can never fix it either. Every bug in the copied code is permanently Crucible's.
That is the strongest reason the copied subset stays small and the state-coupled components are rebuilt rather than adapted.

## Amendment (2026-09-07): rebuild tiebreak

Two rules sharpen the vendor/rebuild split, recorded while
[approving the migration handoff](https://github.com/DevFlow-HQ/devflow-cli/issues/22). First, when a component fits both a vendored category and
a state-coupled rebuild row, **state-coupled wins and it is rebuilt**. Second, a rebuild is never a blank-page design: before rebuilding a
component, study its OpenCode counterpart for architecture, low-level design, and behaviour, and record in the implementing issue what was taken
and what was deliberately changed. The concrete vendored-versus-rebuilt list is spec-level work for the shell milestone and is materialized by the
`UPSTREAM` record. The shipped third-party notices file is `THIRD-PARTY-NOTICES.md` at the repository root, created by the same extraction commit as
`UPSTREAM`, listed in `package.json` `files`, and verified by the release gate of
[ADR 0027](./0027-gate-releases-on-three-os-ci-and-recorded-human-evidence.md).

## Amendment (2026-09-10): the three extra OpenCode-branded theme drops

The first extraction ([#55](https://github.com/secantdev/secant/issues/55)) vendored the theme set, and beyond the five product-named themes
this ADR already drops — Cursor, Vercel, GitHub, Material, and Monokai — it dropped **three more** because they are OpenCode-branded rather than
generic community palettes: `opencode`, `orng`, and `lucent-orng` (OpenCode's signature theme and its two orange house palettes). Shipping a theme
that carries the upstream tool's own identity inside Crucible raises the same naming question the product-named five did, so the same answer applies.
That leaves 25 of the 33 upstream theme assets shipped, each attributed by one line in `THIRD-PARTY-NOTICES.md`. Because the default OpenCode theme was
among the drops, Crucible's shipped default is `nord` — a widely-known MIT community palette — and there is no theme picker and no persisted preference
yet.

## Amendment (ADR 0030): runtime resolved, legacy conhost dropped

[ADR 0030](./0030-ship-the-shell-as-a-bun-compiled-single-file-executable.md) settled the runtime and packaging question this ADR deliberately left
open, and in doing so reversed three sentences above. Recorded here because that ADR names this one in its supersession list:

- **Legacy conhost is no longer a supported host.** ADR 0030 drops the legacy-conhost support-matrix row. Secant still ships the stdin-release
  teardown workaround and prints a one-line notice pointing at Windows Terminal, and the TUI still runs there, but "legacy conhost stays a supported
  host" no longer holds — the segment is surrendered, not preserved.
- **The Bun-adoption conditional has fired.** The clause reading that adopting Bun later "would forfeit legacy conhost support until someone finds a
  Bun-side release" is spent: Bun is the shipped runtime now, and that forfeit is the accepted cost rather than a future risk.
- **The human real-console check retargets to Windows Terminal.** It is re-run when the Bun pin, the OpenTUI pin, or `src/tui/renderer/` changed —
  against Windows Terminal, not the legacy conhost console this ADR aimed it at.
