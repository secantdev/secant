const token = process.env.ISSUE_177_TOKEN ?? "missing-token";

process.stdout.write(`stdout-a:${token}\n`);
await new Promise((resolve) => setImmediate(resolve));
process.stderr.write(`stderr:${token}\n`);
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write(`stdout-b:${token}\n`);
process.exitCode = 17;
