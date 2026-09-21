import { appendFileSync } from "node:fs";

import { runLane } from "./scenario.mjs";

const summaries = [];
const laneCount = Number.parseInt(process.env.ISSUE_177_LANES ?? "12", 10);
for (let lane = 0; lane < laneCount; lane += 1) {
  summaries.push(await runLane(`top-${lane}`));
}
appendFileSync(
  process.env.ISSUE_177_RESULT,
  `${JSON.stringify({ kind: "scenario-summary", summaries })}\n`,
);
