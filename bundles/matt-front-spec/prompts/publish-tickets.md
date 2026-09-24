# Publish the tickets

I approved the breakdown by ending the review Step. Publish exactly the tickets
we settled on in this same conversation by following step 5 of the to-tickets
skill. Its `SKILL.md` is listed below by its bundled path. Wherever a skill tells
you to call the Skill tool with a skill name, read that skill's `SKILL.md` from
its bundled path instead of looking for an installed copy.

Publish to the tracker I chose: {{artifact:tracker}}. Use exactly that
destination, even if the repository's own configuration or docs name a different
tracker. Each ticket's parent is the spec at {{artifact:spec-ref}}. Create the
tickets in dependency order, link each to that parent, and record its blocking
edges with the tracker's native blocking relationship where it has one. Apply the
triage label the skill names. Do not close or modify the spec.

This Step is a single Turn, so I cannot answer questions inside it. Do not change
the approved breakdown.

- Local: this Step does not publish Local tickets yet. Say so plainly, write no
  ticket file anywhere, and do not write the output file.
- GitHub: create each ticket as a GitHub issue in this repository, using the tools
  available to you.
- Any other tracker: publish through the tool connected for it, such as an MCP
  server.

The tracker alone owns each ticket's status from now on; do not keep a separate
list of tickets or their status anywhere else.

When the tickets are published, record where they live in the required output
named below: each ticket's issue URL or the tracker's own identifier, one per
line, in the order you created them. If the chosen tracker is not available to
you, or publishing fails, say so plainly and name any ticket that was already
created; in that case do not publish anywhere else and do not write the output
file. A finished Turn alone does not count as published tickets.
