# Issue 177 Bun child-lifecycle prototype

Throwaway, branch-only prototype for the question in
[`Prove where Bun loses child-process lifecycle evidence under runner stress`](https://github.com/secantdev/secant/issues/177).

It accepts the prototype only when repeated observations distinguish Bun's test
runner from an ordinary Bun parent. Every probe uses `node:child_process` to
spawn the same Bun child and records the `spawn`, stdout, stderr, `exit`, and
`close` observations plus the final `exitCode`. The orchestrator interleaves:

- `bun test`
- `bun test --isolate`
- `bun test --parallel=1`
- ordinary `bun run`
- an ordinary Node parent control

It establishes a baseline, then applies CPU saturation, rapid process churn,
file-descriptor pressure, and all three together. Stressors publish readiness
files; no sleep is used as a readiness mechanism.

The second phase keeps each parent alive across ten complete pressure cycles,
matching the long-lived test-runner shape of the two `westus3` failures. Every
lane mixes a bounded synchronous spawn with asynchronous lifecycle observation.
The child writes an out-of-band completion receipt before exit; if Bun drops its
callbacks, the timeout record also captures the child's Linux `/proc` status and
wait channel. Host PSI and cgroup CPU, memory, and PID counters bracket every
cell.

Run it from the repository root:

```sh
bun prototypes/issue-177-bun-child-lifecycle/run.mjs
```

Results are written under `prototype-results/issue-177/`, which is ignored on
this branch and uploaded by the branch-only GitHub Actions job. The short matrix
defaults to 12 fresh test files with five asynchronous observations each. The
sustained phase defaults to ten cycles with two asynchronous observations per
lane. Override those dimensions with `ISSUE_177_LANES`,
`ISSUE_177_ITERATIONS`, `ISSUE_177_SUSTAINED_CYCLES`, and
`ISSUE_177_SUSTAINED_ITERATIONS`.

Cleanup decision: this directory and the branch-only workflow job never merge.
The ticket resolution links the preserved branch and Actions artifact.
