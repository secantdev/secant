# Slicing Rulebook

Read this before a `/to-spec` or `/to-tickets` session; both read it, and `/to-tickets` cuts each tracer-bullet slice under it. Fixed by the
"Secant slicing rulebook" section of [the sequencing decision](https://github.com/DevFlow-HQ/devflow-cli/issues/20#issuecomment-5568202859); the
milestone loop that feeds it is in [milestones](./milestones.md) and the ticket packet it produces is in [issue tracker](./issue-tracker.md).

These eight rules sit on top of the ordinary vertical-slice rules a slice already obeys: a complete path through every layer, demoable, one context
window, prefactor first, and expand–contract for a wide refactor. A slice that breaks a rule below is not smaller, it is unfinished.

## The eight rules

1. **Both clients.** A user-facing slice lands in the TUI and the headless client over the same Projection Port Operation or Projection. One client
   alone is not done. The one exception: headless v1 rejects a Bundle carrying an Interactive agent step at Preflight, with the remediation "run this
   Bundle in the TUI".
2. **CI is the acceptance path.** Every slice names one CI-run scenario on the three-OS matrix. "Verified locally" is never acceptance.
3. **No scaffolding.** A Module's files are created by the first slice that needs its behaviour, never ahead of it.
4. **Packet lines.** Every ticket carries `Owner:`, `Ratchet:`, and `Deletes:` from [issue tracker](./issue-tracker.md), plus `Gate:` (the
   [ADR 0027](../adr/0027-gate-releases-on-three-os-ci-and-recorded-human-evidence.md) gate this slice introduces or keeps green) and
   `Dependencies:` (each runtime dependency re-earned under the built-ins-first rule).
5. **Bundles are exercised, not fixtures.** Everything under `bundles/` is built, installed, and run the way a user's Bundle is, never stubbed.
6. **No branching on workflow identity.** Nothing in `src/` inspects a Bundle id, name, or asset path to change behaviour. A slice that adds a
   capability names the one seam it landed at, and the reviewer verifies there.
7. **TUI slices copy the #23 deferred items.** Keymap and focus, terminal layout, timeline mechanics, large content, interaction tuning, visual and
   accessibility checks, and renderer and platform evidence go into the slice's acceptance criteria.
8. **Publish without `ready-for-agent`.** Whoever closes the last blocker curates the packet, then adds the label.
