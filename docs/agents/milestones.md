# Milestones

Read this before opening or closing a milestone, gate, or spec issue. The migration ran as seven milestones, M0 to M6, fixed by
[the sequencing decision](https://github.com/secantdev/secant/issues/20#issuecomment-5568202859); all seven are closed, and G4, the last
refactoring gate, followed M6. Tracker mechanics, Starting context, and the implementation-ticket packet are in [issue tracker](./issue-tracker.md);
this file owns only the milestone loop.

## Spine

- The spine is the sequencing resolution above: the milestone table, hard ordering constraints, slicing rulebook, refactoring gates, and disposition.
- Later comments titled `Amendment` on [#20](https://github.com/secantdev/secant/issues/20) and the
  [handoff approval](https://github.com/secantdev/secant/issues/22#issuecomment-5569253373) supersede the resolution text where they differ.
- An ADR at `HEAD` supersedes any ticket wording. Read the ADR, not the ticket, for identifiers, gates, and contracts.
- A milestone may list a preceding human Task (for example the pre-cut rename) as an input, never as its own work.

## After the spine

- The spine defines no milestone after M6, so this loop never opens one on its own. What follows is decided on the wayfinder map
  ([#2](https://github.com/secantdev/secant/issues/2)) and recorded there before implementation work starts.
- The first public release is a human Task issue on the map, not a milestone: the ADR 0028 public-use gates, then the `v0.1.0` tag through the
  protected release path with fresh digest-bound human evidence (ADR 0027). It carries no spec, tickets, or audit.
- [#38](https://github.com/secantdev/secant/issues/38) and [#39](https://github.com/secantdev/secant/issues/39) are picked from the map after that
  release. A further milestone exists only once an `Amendment` on #20 adds its spine row; then the loop below applies to it.

## Opening a milestone

1. A milestone is a spine row. Open it only when the previous milestone, and any refactoring gate the spine places between them, are closed, or the
   human says otherwise.
2. Title `M<n>: <spine title>`. Body sections, in order: **Delivers** (the spine row plus amendments), **Hard constraints** that apply,
   **Gate introduced**, **Done when** (every ticket closed and the gate green on the three-OS matrix). No file paths in the body.
3. Curate one `## Starting context` comment per the issue-tracker rules, from the map's Decisions-so-far, the ADR index, and the previous
   milestone's close-out, chosen by relevance to Delivers. Pin files at `HEAD`. Grill the human on borderline inclusions before publishing.
4. Publish, then stop. One milestone per session; no spec or ticket work in the same session.

## Spec and tickets

- A `/to-spec` session first reads the milestone issue with comments, then invokes the skill against that context, never against the map. The spec
  issue links the milestone and carries no triage label.
- A `/to-tickets` session cuts tracer bullets from the spec under the [slicing rulebook](./slicing.md) and publishes them as sub-issues of the
  milestone with native blocking edges. The packet and ready rules in [issue tracker](./issue-tracker.md) then apply.
- Slice sessions are one ticket each. A session that finishes early curates newly unblocked tickets rather than starting a second slice.

## Closing a milestone and gates

- The milestone closes only after its `Audit: M<n>` ([milestone audit](./milestone-audit.md) owns when it is created and how it runs) has a decision
  comment and every fix-now ticket it cut is closed.
- Close-out comment on the milestone issue: tickets closed, the gate introduced and its CI evidence, deletions performed, one audit line (a link to
  the audit, fix-now tickets closed, hand-over rows named), and anything handed forward. Then close the issue.
- If the spine names a refactoring gate after this milestone, open `G<n>: <title>` as a human-in-the-loop **plan** review. Its checklist is the
  gate pass in [guidance](./guidance.md) plus the `UPSTREAM` record and support matrix current. A gate may reorder remaining slices; it never reopens
  an ADR. Module cohesion, dependency re-earning, and deletion of unused code belong to the audit, not the gate.
- Whoever closes a milestone opens and curates the next spine row, when the spine names one, before considering the closure complete.
