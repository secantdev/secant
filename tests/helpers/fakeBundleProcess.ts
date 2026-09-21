import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type {
  ProcessAdapter,
  SpawnOptions,
  SpawnResult,
} from "../../src/process/process.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import { RUNTIME_NAME } from "./commandBundle.js";

// The one deterministic Process double for the double-backed headless harness. It
// interprets exactly the `<runtime> -e <script>` shapes the `commandBundle.ts`
// authoring helpers emit — no real child is spawned — so every group-A headless
// suite (Command, Repeat, Materialization, Gate Bundles) runs process-free. A
// tamper script performs its real filesystem side effect on the absolute path in
// its args, so a downstream materialization conflict is detected exactly as with a
// real child; the Run Store's artifact Git goes through the fake Git.

const encoder = new TextEncoder();

function exited(text = "", status = 0): SpawnResult {
  return { kind: "exited", status, text: encoder.encode(text) };
}

// The bytes of a `"json"`- or `'single'`-quoted literal.
function unquote(quote: string, body: string): string {
  return quote === '"' ? (JSON.parse(`"${body}"`) as string) : body;
}

// The Repeat-group `check` counter (writeRepeatBundle with `passAt`): it embeds its
// counter path as `p=JSON.stringify(path)` and its threshold as
// `process.exit(n>=<passAt>?0:1)`, so reproduce its real read-increment-write and
// its per-iteration Verdict, driving the same iteration cadence a real child would.
function counter(script: string): SpawnResult {
  const path = /const p=("(?:\\.|[^"])*");/.exec(script);
  const passAt = /process\.exit\(n>=(\d+)\?0:1\)/.exec(script);
  if (path === null || passAt === null) {
    throw new Error(`unrecognised counter script: ${script}`);
  }
  const file = JSON.parse(path[1]!) as string;
  let n = 0;
  try {
    n = Number(readFileSync(file, "utf8")) || 0;
  } catch {
    // First iteration: the counter file does not exist yet.
  }
  n++;
  writeFileSync(file, String(n));
  return exited(`iteration ${n}\n`, n >= Number(passAt[1]) ? 0 : 1);
}

function interpret(script: string): SpawnResult {
  if (script.includes("console.log('iteration '+n)")) return counter(script);

  const write = /writeFileSync\((".*?"),\s*('.*?'|".*?")\)/.exec(script);
  if (write !== null) {
    writeFileSync(JSON.parse(write[1]!) as string, unquote(...tail(write)));
    return exited();
  }
  const remove = /rmSync\((".*?")\)/.exec(script);
  if (remove !== null) {
    rmSync(JSON.parse(remove[1]!) as string);
    return exited();
  }
  const stdout = /process\.stdout\.write\((["'])((?:\\.|(?!\1).)*)\1\)/.exec(
    script,
  );
  if (stdout !== null) return exited(unquote(stdout[1]!, stdout[2]!));
  const log = /console\.log\((["'])((?:\\.|(?!\1).)*)\1\)/.exec(script);
  if (log !== null) return exited(`${unquote(log[1]!, log[2]!)}\n`);
  const exit = /process\.exit\((\d+)\)/.exec(script);
  if (exit !== null) return exited("", Number(exit[1]));

  throw new Error(`unexpected fake Command script: ${script}`);
}

// The writeFileSync literal is JSON-quoted for the path and single-or-double for
// the value; return the value's quote and body for `unquote`.
function tail(match: RegExpExecArray): [string, string] {
  const value = match[2]!;
  return [value[0]!, value.slice(1, -1)];
}

function fakeBundleCommand(
  options: SpawnOptions,
): SpawnResult | Promise<SpawnResult> {
  const [flag, script] = options.args;
  if (flag !== "-e" || script === undefined) {
    throw new Error(
      `unexpected fake Command args: ${JSON.stringify(options.args)}`,
    );
  }
  // A deliberately hung command (the command-timeout / cancellation cases): it
  // never settles on its own — it reports `cancelled` once the caller aborts it,
  // else `timeout`, matching a real child killed by our own timeout.
  if (script.includes("setTimeout(")) {
    const signal = options.cancelSignal;
    if (signal === undefined) return { kind: "timeout" };
    return new Promise<SpawnResult>((resolve) => {
      signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), {
        once: true,
      });
    });
  }
  return interpret(script);
}

/** The shared Process double for the double-backed headless harness. */
export function createFakeBundleProcess(): ProcessAdapter {
  const git = createFakeGitProcess();
  return createFakeProcess({
    resolutionHandler: (name) =>
      name === RUNTIME_NAME
        ? { kind: "found", executable: name, prefixArgs: [] }
        : { kind: "not-found" },
    commandHandler: fakeBundleCommand,
    syncCommandHandler: (options) => git.spawnCommandSync(options),
  });
}
