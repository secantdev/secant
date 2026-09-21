import { writeFileSync } from "node:fs";

const token = process.env.ISSUE_177_TOKEN ?? "missing-token";

process.stdout.write(`stdout-a:${token}\n`);
await new Promise((resolve) => setImmediate(resolve));
process.stderr.write(`stderr:${token}\n`);
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write(`stdout-b:${token}\n`);
if (process.env.ISSUE_177_RECEIPT !== undefined) {
  writeFileSync(
    process.env.ISSUE_177_RECEIPT,
    `${JSON.stringify({ token, pid: process.pid, ppid: process.ppid, completedAt: new Date().toISOString() })}\n`,
  );
}
process.exitCode = 17;
