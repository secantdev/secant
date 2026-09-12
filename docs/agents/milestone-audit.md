# Milestone Audit

Read this before creating, running, or closing an `Audit: M<n>` issue. Decided in
[Define the per-milestone architecture and dependency audit before close-out](https://github.com/secantdev/secant/issues/67#issuecomment-5634896067);
the [amendment on the sequencing decision](https://github.com/secantdev/secant/issues/20) moved the code-facing checks here from the refactoring gates.
The milestone loop that triggers it is in [milestones](./milestones.md); the yardstick it judges dependencies by is in
[dependency discipline](./dependencies.md).

The audit is the backward-looking review of the code a milestone shipped, distinct from the refactoring gates, which stay **plan** reviews with their
checklist in [milestones](./milestones.md). It runs before every milestone closes, gates included, over the whole of `src/` once per milestone.
`ponytail:` marks are hints, never the worklist.

## Flow

1. **Create.** The session that closes the last implementation ticket of a milestone creates `Audit: M<n>` as a sub-issue of the milestone with a
   native blocking edge on the milestone, pastes a Starting context (this document, the milestone issue, the ADR folder, the local OpenCode checkout
   path), and labels it `ready-for-agent`. The OpenCode path lives only in that comment, never in a checked-in file.
2. **Report.** A fresh session runs both checklists below over the whole codebase and posts the **report comment** first, as the two tables under
   Shapes. Output is issue-comment tables, never an HTML report.
3. **Grill.** The same session then grills the human over every row in-session.
4. **Decide.** It posts one **decision comment**: the same rows plus a stamp per row and one line of reason wherever the human overrode the proposal.
5. **Cut.** Fix-now rows become ordinary implementation tickets: sub-issues of the milestone with the normal packet from
   [issue tracker](./issue-tracker.md), each blocking the milestone. The audit issue closes once the decision comment exists and those tickets are cut.
6. **Close out.** Fix-now tickets block the milestone close; hand-over rows are named in the milestone close-out line.

## Dependency checklist

Judge every row against the dependency policy and the growth rule in [dependency discipline](./dependencies.md), and against what OpenCode chose
for the same question. ADR 0030 is a runtime-neutrality rule, not a zero-dependency rule; never tag a library as against it on those grounds.

1. Hand-rolled code a `node:` or `bun:` builtin covers.
2. Hand-rolled code a trusted library covers.
3. Every `package.json` dependency still earned by a live consumer.
4. Every entry in the Bun-API allowlist under `tests/architecture/` still needed, and none added without an ADR 0030 reason.

Licence checks stay with the M4 release gate.

## Architecture checklist

Sources: the vocabulary in [module design](./module-design.md), the [topology](./topology.md) document and its policy table, the ADR folder,
`CONTEXT.md`, and the exploration heuristics: the deletion test, shallow-Module friction, Seam leaks, and code untested through its Interface.
The local OpenCode checkout is the comparison.

1. Grown files reviewed for cohesion: split or merge.
2. Interfaces still narrow; no adapter or storage type leaking past its Module (`application.ts` versus `projection-port.ts` is the worked example).
3. Code that now contradicts an ADR or a guidance document.
4. Dead code, or tests no slice uses. Dead means the caller was deleted or the contract was retired by a decision; declared surface with no
   importer yet is not a finding, per the [engineering baseline](./engineering-baseline.md).
5. Module-local `AGENTS.md` facts stale or missing.
6. Tests mirror the source domains.

## Shapes

- **Report**, two tables. Dependency: Location | Rule judged against | OpenCode does | Finding | Proposed verdict | Fix size (S/M/L).
  Architecture: Location | Principle | Finding | Proposed verdict | Fix size.
- **Decision**: the same rows plus Stamp (fix-now / hand-over / keep) and one line of reason where the human overrode the proposal.
- **Close-out**: one line on the milestone issue: a link to the audit, the fix-now tickets closed, and the hand-over rows named.

## What fix tickets may do

- Anything an implementation ticket may: refactor, rewrite, add or remove dependencies, delete, fix guidance.
- A finding whose fix needs an ADR or policy change becomes a wayfinder ticket on the map, stamped hand-over, and never blocks the milestone.
- Implementation tickets outside the audit keep the obvious calls: adopt a dependency when the policy and OpenCode make it obvious, otherwise
  hand-roll the smallest thing and mark it `ponytail:`. [Change review](./change-review.md) keeps "purpose of each new dependency".

## Pre-graded rows for `Audit: M1`

M1 is the pilot. These rows enter the Dependency report table with the proposed verdict below and status _confirm_; the audit session fills
the remaining columns, and the grilling may still overturn any row. Rejected at the decision: Effect Schema (a paradigm import, not a validation
library), `yargs` (transitive weight; OpenCode is migrating off it), `cac` (small community).

| Location                | Proposed verdict                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Engine-range comparison | Adopt `semver`.                                                                                                                 |
| Manifest validator      | Adopt `zod` v4; confirm per-field error paths against the existing manifest tests.                                              |
| CLI parsing             | Adopt `commander` (zero transitive dependencies). `node:util.parseArgs` rejected: subcommands and help grow with every command. |
| JSON canonicalization   | Keep hand-rolled: frozen, OpenCode hand-rolls it too.                                                                           |
| Update stream           | Keep until a second consumer appears.                                                                                           |
| ZIP codec               | Keep hand-rolled: frozen format, reproducible digest. Optionally reject Zip64 markers explicitly.                               |
