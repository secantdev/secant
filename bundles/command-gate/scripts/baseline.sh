#!/usr/bin/env bash
# Bind a `fail` Verdict so the Repeat loop is entered — the Composition check
# requires the `until` Verdict bound before the group. It does no counting.
echo "gate baseline: loop pending"
exit 1
