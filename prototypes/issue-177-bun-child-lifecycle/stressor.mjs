import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const [kind, readyPath, stopPath, bunPath, childPath] = process.argv.slice(2);
if (kind === undefined || readyPath === undefined || stopPath === undefined) {
  throw new Error("stressor requires kind, ready path, and stop path");
}

if (kind === "cpu") {
  writeFileSync(readyPath, "ready\n");
  let accumulator = 1;
  while (!existsSync(stopPath)) {
    for (let index = 1; index < 1_000_000; index += 1) {
      accumulator = (accumulator * 33 + index) % 2_147_483_647;
    }
  }
  writeFileSync(`${readyPath}.stopped`, "stopped\n");
  process.exit(accumulator === -1 ? 1 : 0);
}

if (kind === "churn") {
  if (bunPath === undefined || childPath === undefined) {
    throw new Error("churn stressor requires Bun and child paths");
  }
  let count = 0;
  while (!existsSync(stopPath)) {
    spawnSync(bunPath, [childPath], {
      env: { ...process.env, ISSUE_177_TOKEN: "churn" },
      stdio: "ignore",
    });
    count += 1;
    if (count === 25) writeFileSync(readyPath, "ready\n");
  }
  if (count < 25) writeFileSync(readyPath, "stopped-before-ready\n");
  writeFileSync(`${readyPath}.stopped`, "stopped\n");
  process.exit(0);
}

throw new Error(`unknown stressor kind: ${kind}`);
