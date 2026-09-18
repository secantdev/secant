import { z } from "zod";
import type { OwnedProcess } from "../../process/process.js";
import {
  boundedCodexExchange,
  CodexJsonlConnection,
  type CodexProtocolObserver,
} from "./runtime-protocol.js";

declare const __SECANT_VERSION__: string;

const MAX_STDERR_BYTES = 64 * 1024;

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

export interface CodexQualificationObserver extends CodexProtocolObserver {
  schema(schema: string): void;
  stdin(bytes: Uint8Array): void;
  stdout(bytes: Uint8Array): void;
  closed(kind: string, status: number | undefined): void;
}

/** Owns the bounded pre-thread JSONL exchange with one app-server child. */
export class CodexQualificationConnection {
  private readonly connection: CodexJsonlConnection;
  private transferred = false;

  constructor(
    private readonly process: OwnedProcess,
    private readonly timeoutMs: number,
    private readonly observer: CodexQualificationObserver | undefined,
  ) {
    this.connection = new CodexJsonlConnection(process, observer);
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

  runtimeConnection(): CodexJsonlConnection {
    if (this.transferred) {
      throw new Error("Codex qualification connection already transferred");
    }
    this.transferred = true;
    this.connection.finishQualificationObservation();
    return this.connection;
  }

  private request(method: string, params: object): Promise<unknown> {
    return boundedCodexExchange({
      operation: () => this.unboundedRequest(method, params),
      timeoutMs: this.timeoutMs,
      label: `${method} qualification exchange`,
    });
  }

  private async unboundedRequest(
    method: string,
    params: object,
  ): Promise<unknown> {
    return this.connection.qualificationRequest(method, params);
  }

  private notify(method: string): Promise<void> {
    return boundedCodexExchange({
      operation: () => this.connection.qualificationNotify(method),
      timeoutMs: this.timeoutMs,
      label: `${method} qualification notification`,
    });
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
      cause = await boundedCodexExchange({
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
