# Repair the failing test

A test is failing at `{{artifact:failing-test}}`. Make the change that turns it green.

- Fix the root cause in the code under test, not the assertion — unless the test itself is wrong.
- Do **not** commit. Leave the working tree changed; a later step commits after a human approves.
- Run only what you need to confirm the fix locally.
