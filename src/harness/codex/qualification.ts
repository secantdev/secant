import { z } from "zod";
import type { OwnedProcess } from "../../process/process.js";

declare const __SECANT_VERSION__: string;

const MAX_STDERR_BYTES = 64 * 1024;

const rpcEnvelopeSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});
const initializeResultSchema = z.looseObject({
  userAgent: z.string().min(1),
  codexHome: z.string().min(1),
  platformFamily: z.string().min(1),
  platformOs: z.string().min(1),
});
const accountResultSchema = z.looseObject({
  account: z
    .union([
      z.null(),
      z.looseObject({
        type: z.enum(["apiKey", "chatgpt", "amazonBedrock"]),
      }),
    ])
    .optional(),
  requiresOpenaiAuth: z.boolean(),
});
const modelResultSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string().min(1),
      model: z.string().min(1),
      displayName: z.string().min(1),
      hidden: z.boolean(),
      isDefault: z.boolean(),
    }),
  ),
});

export interface CodexQualificationObserver {
  schema(schema: string): void;
  stdin(bytes: Uint8Array): void;
  stdout(bytes: Uint8Array): void;
  closed(kind: string, status: number | undefined): void;
}

/** Owns the bounded pre-thread JSONL exchange with one app-server child. */
export class CodexQualificationConnection {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private remainder = "";
  private nextId = 1;

  constructor(
    private readonly process: OwnedProcess,
    private readonly timeoutMs: number,
    private readonly observer: CodexQualificationObserver | undefined,
  ) {
    this.iterator = process.stdout[Symbol.asyncIterator]();
  }

  async initialize(): Promise<void> {
    const version =
      typeof __SECANT_VERSION__ === "string" ? __SECANT_VERSION__ : "0.0.0-dev";
    const result = await this.request("initialize", {
      clientInfo: { name: "secant", title: "Secant", version },
      capabilities: { experimentalApi: false },
    });
    parseResult(result, initializeResultSchema, "initialize");
    await this.notify("initialized");
  }

  async readAccount(): Promise<z.infer<typeof accountResultSchema>> {
    const result = await this.request("account/read", { refreshToken: false });
    return parseResult(result, accountResultSchema, "account/read");
  }

  async listModels(): Promise<void> {
    const result = await this.request("model/list", {
      cursor: null,
      includeHidden: false,
      limit: null,
    });
    parseResult(result, modelResultSchema, "model/list");
  }

  private request(method: string, params: object): Promise<unknown> {
    return bounded({
      operation: () => this.unboundedRequest(method, params),
      timeoutMs: this.timeoutMs,
      label: `${method} qualification exchange`,
    });
  }

  private async unboundedRequest(
    method: string,
    params: object,
  ): Promise<unknown> {
    const id = this.nextId++;
    await this.write({ id, method, params });
    for (;;) {
      const message = await this.readMessage();
      if (message.id === undefined) continue;
      if (message.method !== undefined) {
        throw new Error(
          `unexpected server request '${message.method}' during qualification`,
        );
      }
      if (message.id !== id) {
        throw new Error(`unexpected response id '${String(message.id)}'`);
      }
      if (message.error !== undefined) {
        throw new Error(
          `${method} returned RPC error ${message.error.code}; response rejected`,
        );
      }
      if (!("result" in message)) {
        throw new Error(`${method} response has neither result nor error`);
      }
      return message.result;
    }
  }

  private notify(method: string): Promise<void> {
    return bounded({
      operation: () => this.write({ method }),
      timeoutMs: this.timeoutMs,
      label: `${method} qualification notification`,
    });
  }

  private write(message: object): Promise<void> {
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    this.observer?.stdin(bytes);
    return this.process.writeStdin(bytes);
  }

  private async readMessage(): Promise<z.infer<typeof rpcEnvelopeSchema>> {
    const line = await this.nextLine();
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (cause) {
      throw new Error("Codex emitted malformed JSON during qualification", {
        cause,
      });
    }
    const parsed = rpcEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error(
        `Codex emitted an incompatible RPC envelope: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  private async nextLine(): Promise<string> {
    for (;;) {
      const newline = this.remainder.indexOf("\n");
      if (newline >= 0) {
        const rawLine = this.remainder.slice(0, newline + 1);
        const line = rawLine.slice(0, -1).replace(/\r$/, "");
        this.remainder = this.remainder.slice(newline + 1);
        if (line.trim().length > 0) {
          this.observer?.stdout(new TextEncoder().encode(rawLine));
          return line;
        }
        continue;
      }
      const chunk = await this.iterator.next();
      if (chunk.done) {
        if (this.remainder.trim().length > 0) {
          throw new Error("Codex emitted a truncated JSON frame");
        }
        throw new Error(
          "Codex app-server closed before qualification completed",
        );
      }
      this.remainder += this.decoder.decode(chunk.value, { stream: true });
    }
  }
}

/** Drains stderr independently of protocol stdout and retains bounded evidence. */
export class CodexDiagnosticCapture {
  private readonly decoder = new TextDecoder();
  private readonly completion: Promise<Error | undefined>;
  private captured = "";
  private bytes = 0;

  constructor(stream: AsyncIterable<Uint8Array>) {
    this.completion = this.consume(stream).then(
      () => undefined,
      (cause) =>
        cause instanceof Error
          ? cause
          : new Error("Codex stderr reader failed", { cause }),
    );
  }

  async settle(timeoutMs: number): Promise<CodexDiagnosticResult> {
    let cause: Error | undefined;
    try {
      cause = await bounded({
        operation: () => this.completion,
        timeoutMs,
        label: "Codex stderr drain",
      });
    } catch (error) {
      cause =
        error instanceof Error
          ? error
          : new Error("Codex stderr drain failed", { cause: error });
    }
    if (cause === undefined) return { text: this.captured.trim() };
    return { text: this.captured.trim(), cause };
  }

  private async consume(stream: AsyncIterable<Uint8Array>): Promise<void> {
    for await (const chunk of stream) {
      if (this.bytes >= MAX_STDERR_BYTES) continue;
      const remaining = MAX_STDERR_BYTES - this.bytes;
      const accepted = chunk.subarray(0, remaining);
      this.bytes += accepted.byteLength;
      this.captured += this.decoder.decode(accepted, { stream: true });
    }
    this.captured += this.decoder.decode();
  }
}

interface CodexDiagnosticResult {
  readonly text: string;
  readonly cause?: Error;
}

interface TBounded<T> {
  readonly operation: () => Promise<T>;
  readonly timeoutMs: number;
  readonly label: string;
}

async function bounded<T>(options: TBounded<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${options.label} timed out`)),
      options.timeoutMs,
    );
  });
  try {
    return await Promise.race([options.operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseResult<T>(
  value: unknown,
  schema: z.ZodType<T>,
  method: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${method} returned an incompatible result: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
