#!/usr/bin/env bash
# Run the failing test passed as the first argument. Its exit status becomes the
# Command step's verdict: 0 -> pass, anything else -> fail.
set -euo pipefail
node --test "$1"
