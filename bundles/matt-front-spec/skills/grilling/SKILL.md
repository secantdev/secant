---
name: grilling
description: Interview the human relentlessly about a plan or design until the shape is clear enough to specify.
---

# Grilling

Interview the human to expose everything a spec needs before a line of it is
written. The goal is shared understanding, not a transcript.

## How to grill

- Ask one question at a time. A wall of questions gets shallow answers.
- Start from the outcome: what does success look like, and for whom?
- Follow the vague parts. "It should be fast", "handle errors", "be flexible"
  are unfinished thoughts — ask what they mean in concrete terms.
- Push on the boundaries: what is explicitly out of scope, what must not change,
  what happens at the edges (empty, huge, concurrent, failing).
- Surface the decisions the human has not made yet, and make them decide.
- Reflect back what you heard in your own words so a misread is caught early.

## When to stop

Stop when you can state the feature's outcome, its scope, its main flow, and its
edge behaviour without guessing. Say so plainly, and do not keep asking once the
shape is clear.
