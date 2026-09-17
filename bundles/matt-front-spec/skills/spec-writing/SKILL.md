---
name: spec-writing
description: Turn a shared understanding into a clear, testable feature specification.
---

# Spec writing

Write a specification that a builder could implement and a reviewer could check
against, using only what the interview established.

## Structure

- **Summary** — one paragraph: what the feature is and why it exists.
- **Goals / Non-goals** — what it must do, and what it deliberately will not.
- **Behaviour** — the main flow, stated as concrete steps or scenarios.
- **Edge cases** — the empty, large, concurrent, and failing paths, each with
  the expected behaviour.
- **Acceptance criteria** — a checklist a reviewer can tick off.

## Rules

- Specify only what the interview settled. If something never came up, leave it
  out rather than invent it.
- Prefer concrete, testable statements over adjectives. "Responds within 200ms"
  beats "is fast".
- Keep it to the one file you were asked to write.
