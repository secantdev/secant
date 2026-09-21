import { appendFileSync } from "node:fs";

import { runLane } from "./scenario.mjs";

const axes = ["baseline", "cpu", "churn", "fd", "combined"];
const cycles = Number.parseInt(
  process.env.ISSUE_177_SUSTAINED_CYCLES ?? "10",
  10,
);
const summaries = [];
for (let cycle = 0; cycle < cycles; cycle += 1) {
  for (const axis of axes) {
    summaries.push(await runLane(`sustained-${cycle}-${axis}`, axis));
  }
}
appendFileSync(
  process.env.ISSUE_177_RESULT,
  `${JSON.stringify({ kind: "scenario-summary", summaries })}\n`,
);
