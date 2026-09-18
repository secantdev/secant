import type { CodexRecordingObserver } from "../../src/harness/harness.js";

export type CodexTrafficDirection = "stdin" | "stdout" | "stderr";

export interface CodexTrafficEntry {
  readonly direction: CodexTrafficDirection;
  readonly line: string;
}

export interface CodexRecordingCapture {
  readonly observer: CodexRecordingObserver;
  readonly traffic: CodexTrafficEntry[];
  executableVersion?: string;
  protocolVersion?: string;
  schema?: string;
  exit?: { readonly kind: string; readonly status: number | undefined };
}

/** Preserve each UTF-8 stream across arbitrary process chunks. JSONL stdin and
 * stdout normally arrive whole, while stderr is allowed to split a scalar. */
export function createCodexRecordingCapture(): CodexRecordingCapture {
  const traffic: CodexTrafficEntry[] = [];
  const decoders = {
    stdin: new TextDecoder(),
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  };
  const append = (
    direction: CodexTrafficDirection,
    bytes?: Uint8Array,
  ): void => {
    const line = decoders[direction].decode(bytes, {
      stream: bytes !== undefined,
    });
    if (line.length > 0) traffic.push({ direction, line });
  };
  const capture: CodexRecordingCapture = {
    traffic,
    observer: {
      version(version) {
        capture.executableVersion = version;
      },
      schema(schema, probeRevision) {
        capture.schema = schema;
        capture.protocolVersion = probeRevision;
      },
      stdin(bytes) {
        append("stdin", bytes);
      },
      stdout(bytes) {
        append("stdout", bytes);
      },
      stderr(bytes) {
        append("stderr", bytes);
      },
      closed(kind, status) {
        append("stdin");
        append("stdout");
        append("stderr");
        capture.exit = { kind, status };
      },
    },
  };
  return capture;
}
