# Milestones

Read this before opening or closing a milestone, gate, or spec issue. The migration runs as seven milestones, M0 to M6, fixed by
[the sequencing decision](https://github.com/DevFlow-HQ/devflow-cli/issues/20#issuecomment-5568202859). Tracker mechanics, Starting context, and the
implementation-ticket packet are in [issue tracker](./issue-tracker.md); this file owns only the milestone loop.

## Spine

- The spine is the sequencing resolution above: the milestone table, hard ordering constraints, slicing rulebook, refactoring gates, and disposition.
- Later comments titled `Amendment` on [#20](https://github.com/DevFlow-HQ/devflow-cli/issues/20) and the
  [handoff approval](https://github.com/DevFlow-HQ/devflow-cli/issues/22#issuecomment-5569253373) supersede the resolution text where they differ.
- An ADR at `HEAD` supersedes any ticket wording. Read the ADR, not the ticket, for identifiers, gates, and contracts.
- A milestone may list a preceding human Task (for example the pre-cut rename) as an input, never as its own work.

## Opening the next milestone

1. List issues titled `M<n>:`. The next milestone is the lowest `n` without an issue; no issue at all means M0. Open it only when the previous
   milestone is closed or the human says otherwise. A milestone whose curation the spine says is blocked (M6 by
   [#41](https://github.com/DevFlow-HQ/devflow-cli/issues/41)) waits for that blocker.
2. Title `M<n>: <spine title>`. Body sections, in order: **Delivers** (the spine row plus amendments), **Hard constraints** that apply,
   **Gate introduced**, **Done when** (every ticket closed and the gate green on the three-OS matrix). No file paths in the body.
3. Curate one `## Starting context` comment per the issue-tracker rules. M0 and M1 inputs are listed in the resolution and its amendment; later
   milestones are curated from the map's Decisions-so-far, the ADR index, and the previous milestone's close-out, chosen by relevance to Delivers.
   Pin files at `HEAD`. Grill the human on borderline inclusions before publishing.
4. Publish, then stop. One milestone per session; no spec or ticket work in the same session.

## Spec and tickets

- A `/to-spec` session first reads the milestone issue with comments, then invokes the skill against that context, never against the map. The spec
  issue links the milestone and carries no triage label.
- A `/to-tickets` session cuts tracer bullets from the spec under the [slicing rulebook](./slicing.md) in the spine, publishes them as sub-issues of the milestone
  with native blocking edges, and leaves them without `ready-for-agent`. The packet and ready rules in the issue tracker then apply.
- Slice sessions are one ticket each. A session that finishes early curates newly unblocked tickets rather than starting a second slice.

## Closing a milestone and gates

- The session that closes the last implementation ticket creates `Audit: M<n>` under [milestone audit](./milestone-audit.md). The milestone
  closes only after the audit's decision comment exists and every fix-now ticket it cut is closed.
- Close-out comment on the milestone issue: tickets closed, the gate introduced and its CI evidence, deletions performed, one audit line (a link to
  the audit, fix-now tickets closed, hand-over rows named), and anything handed to the next milestone. Then close the issue.
- If the spine names a refactoring gate after this milestone (G1 after M2, G2 after M4, G3 after M5, G4 after M6), open `G<n>: <title>` as a
  human-in-the-loop **plan** review. Its checklist: the full-tree guidance-relevance pass with one representative task per Harness and a transcript
  check, and the `UPSTREAM` record and support matrix current. A gate may reorder remaining slices; it never reopens an ADR. Module cohesion,
  dependency re-earning, and deletion of unused code belong to the audit, not the gate.
- Whoever closes a milestone opens and curates the next one before considering the closure complete.
