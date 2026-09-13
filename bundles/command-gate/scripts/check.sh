#!/usr/bin/env bash
# The gate loop's check. Args: <counter-path> <pass-at>. Increment the counter
# kept in the Workspace (the cwd, which is the Git worktree root) and pass (exit 0)
# once it reaches pass-at, so the loop fails a fixed number of times then passes.
# The exit status becomes the Step's Verdict.
set -euo pipefail
counter="$1"
passat="$2"
n=0
[ -f "$counter" ] && n=$(cat "$counter")
n=$((n + 1))
printf '%s' "$n" > "$counter"
echo "gate iteration $n of $passat"
[ "$n" -ge "$passat" ]
