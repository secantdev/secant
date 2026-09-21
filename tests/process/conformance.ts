import assert from "node:assert/strict";
import type {
  OwnedProcessOptions,
  ProcessAdapter,
  SpawnOptions,
} from "../../src/process/process.js";

export interface ProcessConformanceCase<T> {
  readonly process: ProcessAdapter;
  readonly options: T;
}

export interface InterruptConformanceCase extends ProcessConformanceCase<OwnedProcessOptions> {
  readonly ready: string;
  readonly gracefulMs: number;
  readonly escalated: boolean;
}

export interface ProcessConformanceScenarios {
  readonly label: string;
  resolution(): {
    readonly process: ProcessAdapter;
    readonly foundName: string;
    readonly foundExecutable: string;
    readonly missingName: string;
  };
  commandExit(): ProcessConformanceCase<SpawnOptions> & {
    readonly status: number;
    readonly text: string;
  };
  commandCancellation(): ProcessConformanceCase<SpawnOptions> & {
    cancel(): void;
  };
  ownedExit(): ProcessConformanceCase<OwnedProcessOptions> & {
    readonly stdout: string;
    readonly stderr: string;
    readonly status: number;
  };
  ownedSignal(): ProcessConformanceCase<OwnedProcessOptions> & {
    readonly terminalKind: "exited" | "signal";
  };
  gracefulInterruption(): InterruptConformanceCase;
  forcedBoundInterruption(): InterruptConformanceCase;
  escalatingInterruption(): InterruptConformanceCase;
  treeCleanup(): ProcessConformanceCase<SpawnOptions>;
  failures(): {
    readonly process: ProcessAdapter;
    readonly missingName: string;
    readonly command: SpawnOptions;
    readonly owned: OwnedProcessOptions;
  };
}

export type ProcessConformanceBody = () => void | Promise<void>;
export type RegisterProcessConformanceCase = (
  name: string,
  body: ProcessConformanceBody,
) => void;

export function registerProcessConformanceCases(
  scenarios: ProcessConformanceScenarios,
  register: RegisterProcessConformanceCase,
): void {
  const name = (behaviour: string): string =>
    `[process-parity:${scenarios.label}] ${behaviour}`;

  register(
    name("resolves found and missing executables as typed values"),
    () => {
      const scenario = scenarios.resolution();
      assert.deepEqual(scenario.process.resolveExecutable(scenario.foundName), {
        kind: "found",
        executable: scenario.foundExecutable,
        prefixArgs: [],
      });
      assert.deepEqual(
        scenario.process.resolveExecutable(scenario.missingName),
        {
          kind: "not-found",
        },
      );
    },
  );

  register(
    name("captures stdout before stderr and preserves exit status"),
    async () => {
      const scenario = scenarios.commandExit();
      const result = await scenario.process.spawnCommand(scenario.options);
      assert.equal(result.kind, "exited");
      if (result.kind !== "exited") throw new Error("unreachable");
      assert.equal(result.status, scenario.status);
      assert.equal(new TextDecoder().decode(result.text), scenario.text);
    },
  );

  register(
    name("cancellation settles to the typed cancelled result"),
    async () => {
      const scenario = scenarios.commandCancellation();
      const resultPromise = scenario.process.spawnCommand(scenario.options);
      scenario.cancel();
      assert.deepEqual(await resultPromise, { kind: "cancelled" });
    },
  );

  register(
    name("delivers ordered stdout and stderr before one exit result"),
    async () => {
      const scenario = scenarios.ownedExit();
      const launched = await scenario.process.spawnOwnedProcess(
        scenario.options,
      );
      assert.equal(launched.ok, true);
      if (!launched.ok) throw new Error("unreachable");
      const [stdout, stderr, close] = await Promise.all([
        collect(launched.process.stdout),
        collect(launched.process.stderr),
        launched.process.closed(),
      ]);
      assert.equal(stdout, scenario.stdout);
      assert.equal(stderr, scenario.stderr);
      assert.deepEqual(close, { kind: "exited", status: scenario.status });
      assert.equal(await launched.process.closed(), close);
    },
  );

  register(
    name("reports an outside signal as a typed terminal result"),
    async () => {
      const scenario = scenarios.ownedSignal();
      const launched = await scenario.process.spawnOwnedProcess(
        scenario.options,
      );
      assert.equal(launched.ok, true);
      if (!launched.ok) throw new Error("unreachable");
      const close = await launched.process.closed();
      assert.equal(close.kind, scenario.terminalKind);
    },
  );

  register(
    name("uses the supplied graceful bound before interrupt escalation"),
    async () => {
      await assertInterruption(scenarios.gracefulInterruption());
    },
  );

  register(
    name("force-kills an unresponsive process tree and reports escalation"),
    async () => {
      await assertInterruption(scenarios.escalatingInterruption());
    },
  );

  register(
    name("uses the supplied bound again after forced interruption"),
    async () => {
      await assertInterruption(scenarios.forcedBoundInterruption());
    },
  );

  register(
    name("reaps a tree whose descendant holds the output pipe"),
    async () => {
      const scenario = scenarios.treeCleanup();
      assert.deepEqual(await scenario.process.spawnCommand(scenario.options), {
        kind: "timeout",
      });
    },
  );

  register(name("returns typed resolution and launch failures"), async () => {
    const scenario = scenarios.failures();
    assert.deepEqual(scenario.process.resolveExecutable(scenario.missingName), {
      kind: "not-found",
    });
    assert.deepEqual(await scenario.process.spawnCommand(scenario.command), {
      kind: "spawn-error",
    });
    const launched = await scenario.process.spawnOwnedProcess(scenario.owned);
    assert.equal(launched.ok, false);
    if (launched.ok) throw new Error("unreachable");
    assert.equal(launched.failure.kind, "spawn-error");
  });
}

async function assertInterruption(
  scenario: InterruptConformanceCase,
): Promise<void> {
  const launched = await scenario.process.spawnOwnedProcess(scenario.options);
  assert.equal(launched.ok, true);
  if (!launched.ok) throw new Error("unreachable");
  const stdout = await readUntil(launched.process.stdout, scenario.ready);
  assert.notEqual(stdout, undefined);
  if (stdout === undefined) throw new Error("unreachable");
  const end = stdout.next();
  let endedBeforeTerminal = false;
  void end.then(() => {
    endedBeforeTerminal = true;
  });
  await Promise.resolve();
  assert.equal(endedBeforeTerminal, false);
  const interruption = await launched.process.interrupt(scenario.gracefulMs);
  assert.equal(interruption.escalated, scenario.escalated);
  assert.notEqual(interruption.close.kind, "cleanup-timeout");
  assert.equal(
    await launched.process.interrupt(scenario.gracefulMs),
    interruption,
  );
  assert.equal(await launched.process.closed(), interruption.close);
  assert.equal((await end).done, true);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream)
    text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

async function readUntil(
  stream: AsyncIterable<Uint8Array>,
  expected: string,
): Promise<AsyncIterator<Uint8Array> | undefined> {
  const decoder = new TextDecoder();
  const iterator = stream[Symbol.asyncIterator]();
  let text = "";
  for (;;) {
    const next = await iterator.next();
    if (next.done) return undefined;
    text += decoder.decode(next.value, { stream: true });
    if (text.includes(expected)) return iterator;
  }
}
