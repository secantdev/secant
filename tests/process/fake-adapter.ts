import {
  createProcessAdapter,
  type ExecutableResolution,
  type OwnedProcess,
  type OwnedProcessClose,
  type ProcessAdapter,
  type ProcessInterruption,
  type ResolveExecutableOptions,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncResult,
  type SpawnOwnedProcessResult,
  type SpawnResult,
  type OwnedProcessOptions,
} from "../../src/process/process.js";

/** A Process Interface that resolves and probes through the real Module, but
 *  launches owned processes through a scripted spawn. The Adapter conformance
 *  suites use it to hand a Session process behaviours a real child cannot be made
 *  to produce on demand, now that the Adapters take a Process Interface rather
 *  than a private spawn override. */
export function processWithSpawn(
  spawnOwnedProcess: ProcessAdapter["spawnOwnedProcess"],
): ProcessAdapter {
  const real = createProcessAdapter();
  return {
    resolveExecutable: (name, options) => real.resolveExecutable(name, options),
    spawnCommand: (options) => real.spawnCommand(options),
    spawnCommandSync: (options) => real.spawnCommandSync(options),
    spawnOwnedProcess,
  };
}

export interface FakeResolutionScript {
  readonly name: string;
  readonly result: ExecutableResolution;
}

export type FakeCommandScript =
  | { readonly trigger: "immediate"; readonly result: SpawnResult }
  | { readonly trigger: "cancellation"; readonly result: SpawnResult };

export interface FakeSyncCommandScript {
  readonly result:
    SpawnSyncResult | ((options: SpawnSyncOptions) => SpawnSyncResult);
}

export type FakeOwnedProcessEmission =
  | { readonly kind: "stdout"; readonly bytes: Uint8Array }
  | { readonly kind: "stderr"; readonly bytes: Uint8Array }
  | {
      readonly kind: "terminal";
      readonly trigger: "automatic" | "close-stdin";
      readonly close: OwnedProcessClose;
    }
  | {
      readonly kind: "terminal";
      readonly trigger: "interrupt";
      readonly interruption: ProcessInterruption;
      readonly expectedGracefulMs?: number;
    };

export type FakeOwnedProcessScript =
  | {
      readonly kind: "launch-failure";
      readonly failure: Extract<
        SpawnOwnedProcessResult,
        { readonly ok: false }
      >;
    }
  | {
      readonly kind: "launched";
      readonly emissions: readonly FakeOwnedProcessEmission[];
    };

export interface FakeProcessScript {
  readonly resolutions?: readonly FakeResolutionScript[];
  readonly resolutionHandler?: (name: string) => ExecutableResolution;
  readonly commands?: readonly FakeCommandScript[];
  readonly commandHandler?: (
    options: SpawnOptions,
  ) => SpawnResult | Promise<SpawnResult>;
  readonly syncCommands?: readonly FakeSyncCommandScript[];
  readonly syncCommandHandler?: (options: SpawnSyncOptions) => SpawnSyncResult;
  readonly ownedProcesses?: readonly FakeOwnedProcessScript[];
}

export function createFakeProcess(script: FakeProcessScript): ProcessAdapter {
  return new FakeProcessAdapter(script);
}

class FakeProcessAdapter implements ProcessAdapter {
  private resolutionIndex = 0;
  private commandIndex = 0;
  private syncCommandIndex = 0;
  private ownedProcessIndex = 0;

  constructor(private readonly script: FakeProcessScript) {}

  resolveExecutable(
    name: string,
    _options: ResolveExecutableOptions = {},
  ): ExecutableResolution {
    const entry = this.script.resolutions?.[this.resolutionIndex++];
    if (entry === undefined && this.script.resolutionHandler !== undefined) {
      return this.script.resolutionHandler(name);
    }
    if (entry === undefined) {
      throw new Error(
        `resolveExecutable beyond the scripted resolutions: ${name}`,
      );
    }
    if (entry.name !== name) {
      throw new Error(
        `resolveExecutable expected ${entry.name}, received ${name}`,
      );
    }
    return entry.result;
  }

  spawnCommand(options: SpawnOptions): Promise<SpawnResult> {
    const entry = this.script.commands?.[this.commandIndex++];
    if (entry === undefined && this.script.commandHandler !== undefined) {
      return Promise.resolve(this.script.commandHandler(options));
    }
    if (entry === undefined) {
      throw new Error(
        `spawnCommand beyond the scripted commands: ${options.executable}`,
      );
    }
    if (entry.trigger === "immediate") return Promise.resolve(entry.result);
    if (options.cancelSignal === undefined) {
      throw new Error("scripted cancellation requires a cancelSignal");
    }
    if (options.cancelSignal.aborted) return Promise.resolve(entry.result);
    return new Promise((resolve) => {
      options.cancelSignal!.addEventListener(
        "abort",
        () => resolve(entry.result),
        { once: true },
      );
    });
  }

  spawnCommandSync(options: SpawnSyncOptions): SpawnSyncResult {
    const entry = this.script.syncCommands?.[this.syncCommandIndex++];
    if (entry === undefined && this.script.syncCommandHandler !== undefined) {
      return this.script.syncCommandHandler(options);
    }
    if (entry === undefined) {
      throw new Error(
        `spawnCommandSync beyond the scripted commands: ${options.executable}`,
      );
    }
    return typeof entry.result === "function"
      ? entry.result(options)
      : entry.result;
  }

  spawnOwnedProcess(
    options: OwnedProcessOptions,
  ): Promise<SpawnOwnedProcessResult> {
    const entry = this.script.ownedProcesses?.[this.ownedProcessIndex++];
    if (entry === undefined) {
      throw new Error(
        `spawnOwnedProcess beyond the scripted processes: ${options.executable}`,
      );
    }
    if (entry.kind === "launch-failure") return Promise.resolve(entry.failure);
    return Promise.resolve({
      ok: true,
      process: new FakeOwnedProcess(entry.emissions),
    });
  }
}

class FakeOwnedProcess implements OwnedProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  private readonly stdoutStream = new FakeChunkStream();
  private readonly stderrStream = new FakeChunkStream();
  private readonly closePromise: Promise<OwnedProcessClose>;
  private readonly resolveClose: (close: OwnedProcessClose) => void;
  private readonly terminal: Extract<
    FakeOwnedProcessEmission,
    { readonly kind: "terminal" }
  >;
  private interruptPromise: Promise<ProcessInterruption> | undefined;

  constructor(emissions: readonly FakeOwnedProcessEmission[]) {
    let terminal:
      | Extract<FakeOwnedProcessEmission, { readonly kind: "terminal" }>
      | undefined;
    for (const emission of emissions) {
      if (terminal !== undefined) {
        throw new Error(
          `fake process emitted ${emission.kind} after its terminal result`,
        );
      }
      if (emission.kind === "stdout") this.stdoutStream.emit(emission.bytes);
      else if (emission.kind === "stderr")
        this.stderrStream.emit(emission.bytes);
      else terminal = emission;
    }
    if (terminal === undefined) {
      throw new Error("fake process script has no terminal result");
    }
    this.terminal = terminal;
    this.stdout = this.stdoutStream;
    this.stderr = this.stderrStream;
    let resolveClose!: (close: OwnedProcessClose) => void;
    this.closePromise = new Promise((resolve) => {
      resolveClose = resolve;
    });
    this.resolveClose = resolveClose;
    if (terminal.trigger === "automatic") this.settle(terminal.close);
  }

  writeStdin(_bytes: Uint8Array): Promise<void> {
    return Promise.resolve();
  }

  closeStdin(_timeoutMs: number): Promise<OwnedProcessClose> {
    if (this.terminal.trigger !== "close-stdin") {
      throw new Error(
        `closeStdin cannot settle a ${this.terminal.trigger} fake process`,
      );
    }
    this.settle(this.terminal.close);
    return this.closePromise;
  }

  interrupt(gracefulMs: number): Promise<ProcessInterruption> {
    if (this.interruptPromise !== undefined) return this.interruptPromise;
    if (this.terminal.trigger !== "interrupt") {
      throw new Error(
        `interrupt cannot settle a ${this.terminal.trigger} fake process`,
      );
    }
    if (
      this.terminal.expectedGracefulMs !== undefined &&
      this.terminal.expectedGracefulMs !== gracefulMs
    ) {
      throw new Error(
        `interrupt expected gracefulMs ${this.terminal.expectedGracefulMs}, received ${gracefulMs}`,
      );
    }
    this.settle(this.terminal.interruption.close);
    this.interruptPromise = Promise.resolve(this.terminal.interruption);
    return this.interruptPromise;
  }

  closed(): Promise<OwnedProcessClose> {
    return this.closePromise;
  }

  private settle(close: OwnedProcessClose): void {
    this.stdoutStream.close();
    this.stderrStream.close();
    this.resolveClose(close);
  }
}

class FakeChunkStream implements AsyncIterable<Uint8Array> {
  private readonly buffered: Uint8Array[] = [];
  private readonly readers: Array<
    (result: IteratorResult<Uint8Array>) => void
  > = [];
  private closed = false;

  emit(bytes: Uint8Array): void {
    if (this.closed)
      throw new Error("fake process emitted after terminal result");
    const reader = this.readers.shift();
    if (reader === undefined) this.buffered.push(bytes);
    else reader({ done: false, value: bytes });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) {
      reader({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.buffered.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}
