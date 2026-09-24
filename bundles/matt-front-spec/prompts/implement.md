# Implement one ticket

This is a fresh conversation for one implementation ticket. The spec and its
tickets live in the tracker I chose: {{artifact:tracker}}. The spec is at
{{artifact:spec-ref}}

The tickets were published to:
{{artifact:tickets-ref}}

Read the tracker now, not an earlier list and not this message's copy of it:
tickets may have been added, edited, or finished since they were published. Find
the current ready frontier: the open tickets marked ready-for-agent whose every
blocker is already done. Choose exactly one of them. Never choose a ticket with an
unfinished blocker.

Before any other work, tell me the exact reference of the ticket you chose, so I
can catch a wrong choice. Then implement only that ticket by following the
implement skill. Its `SKILL.md` and the tdd, code-review and codebase-design
skills it relies on are listed below by their bundled paths. Wherever a skill
tells you to call the Skill tool with a skill name, such as /tdd or /code-review,
read that skill's `SKILL.md` from its bundled path instead of looking for an
installed copy. The issue tracker the skills ask for is the tracker named above,
even if the repository's own configuration or docs name a different tracker.

You and I manage the code, the commits, the review, and the ticket together.
Update the chosen ticket's status in the tracker yourself as part of the work, so
the next fresh conversation sees its current state. Secant does not read the
tracker, close or move a ticket, or keep a list of tickets, and nothing either of
us says in this conversation ends the ticket or the stage.

- Local: the Local tracker is the directory `{{run:working-area}}`. Each ticket is a
  file `issues/<NN>-<slug>.md` inside it, with a `Blocked by` line naming the
  tickets it waits on and a `Status` line. Name the chosen ticket by the file's
  absolute path. Record progress by editing that file's `Status` line. Do not
  write planning files into the project Workspace, and never delete or rename a
  ticket file.
- GitHub: the tickets are GitHub issues in this repository. Read them, their
  labels, and their native blocking relationships with the tools available to
  you. Name the chosen ticket by its issue URL. Record progress on that issue.
- Any other tracker: read it through the tool connected for it, such as an MCP
  server. Name the chosen ticket by the tracker's own identifier. Record progress
  on that ticket.

If no ticket is ready, or you cannot read the tracker, say so plainly and stop:
do not read another tracker in its place and do not start any other work. I
decide what happens next.

I may ask more questions in later messages of this same conversation. When I am
finished with this ticket I press Continue, which does not close it: the next
fresh conversation reads the tracker again and may choose it again if it is still
open. When you and I have checked that no implementation ticket is left, I end
the implementation stage myself.
