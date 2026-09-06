# Issue Tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`, including its labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull Requests As A Triage Surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. Resolve an ambiguous number with `gh pr view <number>` and fall back to `gh issue view <number>`.

## Skill Operations

When a skill says "publish to the issue tracker," create a GitHub issue. When it says "fetch the relevant ticket," use `gh issue view <number> --comments`.

## Starting Context

A ticket becomes work-ready through one comment beginning `## Starting context`, added when its final blocker closes. The comment links the smallest
useful set of exact inputs as a table (Input, Why it matters, Authority: canonical, research, or advisory) with commit-pinned files, and gives the
reading rule. Link an indexed folder only when choosing among its contents is part of the work. Ticket bodies stay free of file paths.

Whoever closes a ticket curates Starting context for every ticket whose final open blocker just closed, before considering the closure complete.

## Wayfinding Operations

The map is one issue labelled `wayfinder:map`; its decision tickets are child issues.

- **Map**: create with `gh issue create --label wayfinder:map`.
- **Child ticket**: link the issue as a GitHub sub-issue using the sub-issues API. If sub-issues are unavailable, add it to a task list in the map
  body and put `Part of #<map>` at the top of the child body. Label it `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or
  `wayfinder:task`.
- **Blocking**: use GitHub's native issue dependencies. Add an edge with
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`, where the database id comes
  from `gh api repos/<owner>/<repo>/issues/<number> --jq .id`. If dependencies are unavailable, use `Blocked by: #<number>` in the child body.
- **Context-ready**: keep the ticket body question-only. Add `wayfinder:context-ready` once the Starting context comment exists. Remove the label
  whenever the question or dependencies change enough to make that context stale.
- **Frontier**: list the map's open children and exclude tickets with open blockers, an assignee, or no `wayfinder:context-ready` label. During
  initial charting, curate context only for the initial unblocked tickets.
- **Claim**: assign a context-ready ticket before starting with `gh issue edit <number> --add-assignee @me`.
- **Resolve**: comment with the answer, close the ticket, append a linked one-line gist to the map's Decisions-so-far, then prepare Starting context
  for every newly unblocked child.

## Implementation Tickets

Implementation tickets come from `/to-tickets` with its own body template (Parent, What to build, Acceptance criteria, Blocked by). Publish them
**without** `ready-for-agent`.

- **Packet**: the Starting context comment above, followed by three lines. `Owner:` the Module and Interface touched. `Ratchet:` the checks this
  ticket adds or retires. `Deletes:` the behavior, tests, exports, or dependencies it removes. Fixtures touched are table rows.
- **Ready**: apply `ready-for-agent` only once the packet comment exists.
- **Complete**: follow `change-review.md` on the ticket before closing it.
