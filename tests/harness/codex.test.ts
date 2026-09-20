import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CODEX_EXECUTABLE_ENV,
  createCodexAdapter,
  type CodexRecordingObserver,
  type DurableTurnRecorder,
  type HarnessPlatform,
  type PreparedHarness,
  type RecoveryCoordinate,
  type TurnEvent,
  type TurnRequest,
} from "../../src/harness/harness.js";
import type { OwnedProcess } from "../../src/process/process.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { seedTestRepairWorkspace } from "../helpers/testRepairWorkspace.js";
import {
  runExactThreadRecoveryCases,
  runApprovalRequestCases,
  runInterruptRecoveryCases,
  runNativeSteerCases,
  runPrepareProfileCases,
  runTurnLifecycleCases,
  type ApprovalRequestScenarios,
} from "./conformance.js";
import {
  installCodexReplayer,
  installSyntheticCodexReplayer,
  type InstalledCodexReplayer,
} from "./codex-replayer.js";
import {
  CODEX_RECORDING_INPUT,
  codexTestRepairPrompt,
} from "./codex-recording-cases.js";
import { createCodexRecordingCapture } from "./codex-recording.js";

const replayer = installSyntheticCodexReplayer();

runPrepareProfileCases({
  label: "codex",
  baseline: () => () => createCodexAdapter({ path: replayer.path, env: {} }),
  prepareFailure: () => () =>
    createCodexAdapter({
      path: makeTempDir("secant-codex-empty-"),
      env: {},
    }),
});

runTurnLifecycleCases({
  label: "codex-turn-lifecycle",
  inputText: CODEX_RECORDING_INPUT.completion,
  baseline: () => () =>
    createCodexAdapter({
      path: installCodexReplayer("completion").path,
      env: {},
    }),
  prepareFailure: () => () =>
    createCodexAdapter({
      path: makeTempDir("secant-codex-empty-"),
      env: {},
    }),
  failedTurn: () => () =>
    createCodexAdapter({ path: failedTurnReplayer().path, env: {} }),
});

runNativeSteerCases({
  label: "codex-recorded-conformance",
  inputText: CODEX_RECORDING_INPUT.steer,
  guidanceText: CODEX_RECORDING_INPUT.steerGuidance,
  steerableTurn: () => () =>
    createCodexAdapter({
      path: installCodexReplayer("steer").path,
      env: {},
    }),
});

runInterruptRecoveryCases({
  label: "codex-recorded-conformance",
  inputText: CODEX_RECORDING_INPUT.completion,
  interruptInputText: CODEX_RECORDING_INPUT.sleep,
  resumeInputText: CODEX_RECORDING_INPUT.resume,
  baseline: () => () =>
    createCodexAdapter({
      path: installCodexReplayer("completion").path,
      env: {},
    }),
  prepareFailure: () => () =>
    createCodexAdapter({
      path: makeTempDir("secant-codex-empty-"),
      env: {},
    }),
  failedTurn: () => () =>
    createCodexAdapter({ path: failedTurnReplayer().path, env: {} }),
  blockingTurn: () => () =>
    createCodexAdapter({
      path: installCodexReplayer("interrupt").path,
      env: {},
    }),
  unresponsiveInterrupt: () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({
      withholdTerminal: true,
      stallInterruptResponse: true,
    });
    return () =>
      createCodexAdapter({
        path: installed.path,
        env: {},
        controlTimeoutMs: 500,
        cleanupTimeoutMs: 20,
      });
  },
  lostCompletion: () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({ stopAfter: "accepted" });
    return () => createCodexAdapter({ path: installed.path, env: {} });
  },
  resumeAcknowledged: () => () =>
    createCodexAdapter({
      path: installCodexReplayer("resume").path,
      env: {},
    }),
  resumeUnacknowledged: () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({
      withholdTerminal: true,
      interruptTerminal: "interrupted",
    });
    installed.configureRecovery({ threadId: "different-thread" });
    return () => createCodexAdapter({ path: installed.path, env: {} });
  },
});

runExactThreadRecoveryCases({
  label: "codex-exact-thread-recovery",
  resumeAcknowledged: () => exactRecoveryReplayer("thread-1"),
  resumeUnacknowledged: () => exactRecoveryReplayer("different-thread"),
});

const codexApprovalScenarios: ApprovalRequestScenarios = {
  label: "codex-approval-contract",
  concurrentCount: 2,
  awaitedInputText: CODEX_RECORDING_INPUT.approval,
  concurrentRequests: () => () =>
    createCodexAdapter({
      path: installCodexReplayer("codex-approval-contract").path,
      env: {},
    }),
  awaitedApproval: () => () =>
    createCodexAdapter({
      path: installCodexReplayer("approval").path,
      env: {},
    }),
  interruptible: () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({
      approvals: [
        {
          id: "interrupt-command",
          kind: "command",
          itemId: "interrupt-command-1",
          command: "bun test",
        },
      ],
      interruptTerminal: "interrupted",
    });
    return () => createCodexAdapter({ path: installed.path, env: {} });
  },
};

runApprovalRequestCases(codexApprovalScenarios);

test("Codex approval allow and deny map only to native accept and decline", async () => {
  const installed = installCodexReplayer("codex-approval-contract");
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 2);
  const requests = events.flatMap((event) =>
    event.kind === "request-raised" ? [event.request] : [],
  );
  assert.deepEqual(
    requests.map((request) => request.shape),
    [
      {
        kind: "approval",
        tool: "command",
        input: "bun test",
        decisions: ["allow", "deny"],
      },
      {
        kind: "approval",
        tool: "file-change",
        input: "update src/file.ts",
        decisions: ["allow", "deny"],
      },
    ],
  );
  await turn.answerRequest({
    requestId: requests[0]!.requestId,
    kind: "approval",
    decision: "allow",
  });
  await turn.answerRequest({
    requestId: requests[1]!.requestId,
    kind: "approval",
    decision: "deny",
  });
  assert.equal((await turn.result()).kind, "completed");
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const responses = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .filter(
      (message) => message.method === undefined && message.result !== undefined,
    );
  assert.deepEqual(responses.slice(-2), [
    { id: 5, result: { decision: "accept" } },
    { id: "server-file-1", result: { decision: "decline" } },
  ]);
  await prepared.close();
});

test("native approval resolution wins over a late answer while peers remain independent", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "resolved",
        kind: "command",
        itemId: "command-1",
        command: "bun test",
      },
      {
        id: "live",
        kind: "file",
        itemId: "file-change-1",
        changes: [{ path: "src/file.ts", kind: "update" }],
      },
    ],
    resolveFirstApproval: true,
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForExpiredRequestCount(turn, events, 1);
  const requests = events.flatMap((event) =>
    event.kind === "request-raised" ? [event.request] : [],
  );
  assert.deepEqual(
    await turn.answerRequest({
      requestId: requests[0]!.requestId,
      kind: "approval",
      decision: "allow",
    }),
    { outcome: "rejected", reason: "already-settled" },
  );
  assert.deepEqual(
    await turn.answerRequest({
      requestId: requests[1]!.requestId,
      kind: "approval",
      decision: "allow",
    }),
    { outcome: "accepted" },
  );
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

test("concurrent answers write exactly one native decision", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "one-answer",
        kind: "command",
        itemId: "command-1",
        command: "bun test",
      },
    ],
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 1);
  const request = events.find((event) => event.kind === "request-raised");
  assert.ok(request?.kind === "request-raised");
  const receipts = await Promise.all([
    turn.answerRequest({
      requestId: request.request.requestId,
      kind: "approval",
      decision: "allow",
    }),
    turn.answerRequest({
      requestId: request.request.requestId,
      kind: "approval",
      decision: "deny",
    }),
  ]);
  assert.deepEqual(receipts, [
    { outcome: "accepted" },
    { outcome: "rejected", reason: "already-settled" },
  ]);
  assert.equal((await turn.result()).kind, "completed");
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const nativeAnswers = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .filter((message) => message.id === "one-answer");
  assert.deepEqual(nativeAnswers, [
    { id: "one-answer", result: { decision: "accept" } },
  ]);
  await prepared.close();
});

test("a duplicate native server request id fails the Turn closed", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "duplicate",
        kind: "command",
        itemId: "command-1",
        command: "bun test",
      },
    ],
    duplicateFirstApproval: true,
  });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  assert.match(result.detail.failure?.diagnostics ?? "", /reused/);
  await prepared.close();
});

test("a moved file approval exposes both exact paths", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "move-file",
        kind: "file",
        itemId: "file-change-1",
        changes: [
          {
            path: "src/old.ts",
            kind: "update",
            movePath: "src/new.ts",
          },
        ],
      },
    ],
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 1);
  const request = events.find((event) => event.kind === "request-raised");
  assert.ok(request?.kind === "request-raised");
  assert.equal(request.request.shape.kind, "approval");
  if (request.request.shape.kind !== "approval") throw new Error("unreachable");
  assert.equal(request.request.shape.input, "move src/old.ts to src/new.ts");
  await turn.answerRequest({
    requestId: request.request.requestId,
    kind: "approval",
    decision: "deny",
  });
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

for (const nativeRace of ["resolution", "terminal"] as const) {
  test(`${nativeRace} wins while an approval answer write is in flight`, async () => {
    const installed = installSyntheticCodexReplayer();
    const controlled = approvalRaceProcess();
    const preparedResult = await createCodexAdapter({
      path: installed.path,
      env: {},
      spawn: () => Promise.resolve({ ok: true, process: controlled.process }),
    }).prepare({ workspace: process.cwd() });
    assert.equal(preparedResult.ok, true);
    if (!preparedResult.ok) throw new Error("unreachable");
    const prepared = preparedResult.harness;
    const turn = prepared.startTurn(turnRequest());
    const events = observeEvents(turn);
    await waitForRequestCount(turn, events, 1);
    const request = events.find((event) => event.kind === "request-raised");
    assert.ok(request?.kind === "request-raised");
    const answer = turn.answerRequest({
      requestId: request.request.requestId,
      kind: "approval",
      decision: "allow",
    });
    await controlled.responseWriteStarted;
    if (nativeRace === "resolution") {
      controlled.emitResolution();
      await waitForExpiredRequestCount(turn, events, 1);
      controlled.releaseResponseWrite();
      assert.deepEqual(await answer, {
        outcome: "rejected",
        reason: "already-settled",
      });
      controlled.emitTerminal();
    } else {
      controlled.emitTerminal();
      assert.equal((await turn.result()).kind, "completed");
      controlled.releaseResponseWrite();
      assert.deepEqual(await answer, {
        outcome: "rejected",
        reason: "expired",
      });
    }
    assert.equal((await turn.result()).kind, "completed");
    assert.equal(
      events.filter((event) => event.kind === "request-expired").length,
      1,
    );
    await prepared.close();
  });
}

test("approval response write failure preserves its cause and expires the request", async () => {
  const installed = installSyntheticCodexReplayer();
  const controlled = approvalRaceProcess();
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    spawn: () => Promise.resolve({ ok: true, process: controlled.process }),
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const prepared = preparedResult.harness;
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 1);
  const request = events.find((event) => event.kind === "request-raised");
  assert.ok(request?.kind === "request-raised");
  const answer = turn.answerRequest({
    requestId: request.request.requestId,
    kind: "approval",
    decision: "allow",
  });
  await controlled.responseWriteStarted;
  const cause = new Error("scripted approval response write failure");
  controlled.rejectResponseWrite(cause);
  assert.deepEqual(await answer, { outcome: "rejected", reason: "expired" });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.cause, cause);
  assert.equal(
    events.filter((event) => event.kind === "request-expired").length,
    1,
  );
  await prepared.close();
});

test("terminal truth expires an outstanding approval before settling", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "expired",
        kind: "command",
        itemId: "command-1",
        command: "bun test",
      },
    ],
    completeWithOutstandingApproval: true,
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  assert.equal((await turn.result()).kind, "completed");
  const request = events.find((event) => event.kind === "request-raised");
  assert.ok(request?.kind === "request-raised");
  assert.equal(
    events.filter((event) => event.kind === "request-expired").length,
    1,
  );
  assert.deepEqual(
    await turn.answerRequest({
      requestId: request.request.requestId,
      kind: "approval",
      decision: "allow",
    }),
    { outcome: "rejected", reason: "expired" },
  );
  await prepared.close();
});

test("close expires an outstanding approval before native interruption", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      {
        id: "close-command",
        kind: "command",
        itemId: "close-command-1",
        command: "bun test",
      },
    ],
    interruptTerminal: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 1);
  await waitForSession(turn);

  assert.equal((await prepared.close()).clean, true);
  assert.equal((await turn.result()).kind, "interrupted");
  const expired = events.filter((event) => event.kind === "request-expired");
  assert.equal(expired.length, 1);
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  assert.equal(
    JSON.parse(appServer.stdinLines.at(-1) ?? "{}").method,
    "turn/interrupt",
  );
});

test("unsupported mandatory Codex approval shapes fail closed", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      { id: "unsupported", kind: "unsupported-command", itemId: "stdin-1" },
    ],
  });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  await prepared.close();
});

test("a file approval without exact file-change context fails closed", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [{ id: "file", kind: "file", itemId: "missing-file-change" }],
  });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  assert.match(
    result.detail.failure?.diagnostics ?? "",
    /without exact action context/,
  );
  await prepared.close();
});

test("experimental request-user-input remains disabled and fails closed", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    approvals: [
      { id: "request-input", kind: "request-user-input", itemId: "input-1" },
    ],
  });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  assert.equal(prepared.profile.clarifications.available, false);
  await prepared.close();
});

function failedTurnReplayer() {
  const installed = installSyntheticCodexReplayer();
  installed.failTurn("scripted terminal failure");
  return installed;
}

function exactRecoveryReplayer(threadId: string) {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  installed.configureRecovery({ threadId });
  return () =>
    createCodexAdapter({
      path: installed.path,
      env: {},
      controlTimeoutMs: 500,
    });
}

test("refused durable admission sends no prompt content", async () => {
  const installed = installSyntheticCodexReplayer();
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(
    turnRequest({
      admit: () =>
        Promise.resolve({ recorded: false, reason: "run.db refused" }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    }),
  );

  assert.equal((await turn.result()).kind, "not-started");
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const messages = appServer.stdinLines.map((line) => JSON.parse(line));
  assert.ok(messages.some((message) => message.method === "thread/start"));
  assert.ok(messages.every((message) => message.method !== "turn/start"));
  assert.ok(
    appServer.stdinLines.every((line) => !line.includes("private prompt")),
  );
  await prepared.close();
});

for (const stopAfter of ["accepted", "item-completed"] as const) {
  test(`${stopAfter} without terminal truth settles lost`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({ stopAfter });
    const prepared = await prepareCodex(installed.path);
    const result = await prepared.startTurn(turnRequest()).result();
    assert.equal(result.kind, "lost");
    if (result.kind !== "lost") throw new Error("unreachable");
    assert.equal(result.detail.unknown, "completion");
    await prepared.close();
  });
}

test("a malformed runtime frame loses the Turn without fabricating completion", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ malformedFrame: true });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  await prepared.close();
});

test("a truncated runtime frame loses the Turn as protocol corruption", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ truncatedFrame: true });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  await prepared.close();
});

test("a CRLF-delimited Codex terminal frame completes through the Adapter", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ terminalLineEnding: "crlf" });
  const capture = createCodexRecordingCapture();
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    recordingObserver: capture.observer,
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const result = await preparedResult.harness.startTurn(turnRequest()).result();
  assert.equal(result.kind, "completed");
  await preparedResult.harness.close();

  const terminal = capture.traffic.find(
    (entry) =>
      entry.direction === "stdout" && entry.line.includes('"turn/completed"'),
  );
  assert.ok(terminal !== undefined);
  assert.equal(terminal.line.endsWith("\r\n"), true);
});

test("supported Codex item lifecycles use semantic Harness events", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ fullActivity: true });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  assert.equal((await turn.result()).kind, "completed");
  const tools = events
    .filter((event) => event.kind === "tool-activity")
    .map((event) => event.activity.tool);
  assert.deepEqual(
    new Set(tools),
    new Set([
      "command",
      "file-change",
      "mcp:docs/read",
      "subagent",
      "web-search",
      "dynamic:custom",
      "image-view",
      "image-generation",
    ]),
  );
  assert.ok(
    events.some(
      (event) =>
        event.kind === "activity" &&
        event.description === "Codex futureDisplayItem completed",
    ),
  );
  await prepared.close();
});

test("retrying errors remain nonterminal activity", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ retryingError: "temporary overload" });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const events = observeEvents(turn);
  assert.equal((await turn.result()).kind, "completed");
  assert.ok(
    events.some(
      (event) =>
        event.kind === "activity" &&
        event.description.includes("retrying") &&
        event.description.includes("temporary overload"),
    ),
  );
  await prepared.close();
});

test("retry evidence is not reused as terminal failure evidence", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.failTurn("authoritative terminal failure");
  installed.configureTurn({ retryingError: "temporary overload" });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") throw new Error("unreachable");
  assert.equal(
    result.detail.failure.diagnostics,
    "authoritative terminal failure",
  );
  await prepared.close();
});

for (const malformed of ["malformedItem", "malformedTerminal"] as const) {
  test(`${malformed} fails closed as protocol corruption`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({ [malformed]: true });
    const prepared = await prepareCodex(installed.path);
    const result = await prepared.startTurn(turnRequest()).result();
    assert.equal(result.kind, "lost");
    if (result.kind !== "lost") throw new Error("unreachable");
    assert.equal(result.detail.failure?.category, "protocol-corruption");
    await prepared.close();
  });
}

test("only the matching terminal Turn event can settle", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ mismatchedTerminal: true });
  const prepared = await prepareCodex(installed.path);
  const result = await prepared.startTurn(turnRequest()).result();
  assert.equal(result.kind, "completed");
  await prepared.close();
});

test("later fresh Turns reuse one private thread and continue RPC ids", async () => {
  const installed = installCodexReplayer("two-turns");
  const prepared = await prepareCodex(installed.path);
  assert.equal(
    (
      await prepared
        .startTurn(
          turnRequest(undefined, {
            text: CODEX_RECORDING_INPUT.completion,
          }),
        )
        .result()
    ).kind,
    "completed",
  );
  assert.equal(
    (
      await prepared
        .startTurn(
          turnRequest(undefined, {
            text: CODEX_RECORDING_INPUT.secondCompletion,
          }),
        )
        .result()
    ).kind,
    "completed",
  );
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const requests = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .filter((message) => message.id !== undefined);
  assert.deepEqual(
    requests.map((message) => [message.id, message.method]),
    [
      [1, "initialize"],
      [2, "account/read"],
      [3, "model/list"],
      [4, "thread/start"],
      [5, "turn/start"],
      [6, "turn/start"],
    ],
  );
  await prepared.close();
});

test("codex-live-controls steers the exact active native Turn", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ withholdTerminal: true });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.steer({ text: "inspect the other seam" }), {
    outcome: "accepted",
  });
  await prepared.close();
  await turn.result();

  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const steer = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .find((message) => message.method === "turn/steer");
  assert.deepEqual(steer?.params, {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "inspect the other seam" }],
  });
});

test("codex-live-controls interrupts only from matching terminal truth", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptTerminal: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "interrupted");

  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const interrupt = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .find((message) => message.method === "turn/interrupt");
  assert.deepEqual(interrupt?.params, {
    threadId: "thread-1",
    turnId: "turn-1",
  });
  await prepared.close();
});

test("codex-live-controls does not turn interrupt acknowledgement into terminal truth", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ withholdTerminal: true });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.deepEqual(await turn.interrupt(), {
    outcome: "rejected",
    reason: "already-settled",
  });
  let settled = false;
  void turn.result().then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(await turn.steer({ text: "too late" }), {
    outcome: "rejected",
    reason: "expired",
  });

  await prepared.close();
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
});

test("codex-live-controls child loss before confirmation keeps interruption unknown", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptTerminal: "exit",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
  assert.equal(result.detail.failure?.category, "interruption-unknown");
  await prepared.close();
});

test("codex-live-controls native interrupt rejection does not poison later input", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptRpcError: "stale",
    steerTerminal: "completed",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), {
    outcome: "rejected",
    reason: "expired",
  });
  assert.deepEqual(await turn.steer({ text: "continue instead" }), {
    outcome: "accepted",
  });
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

test("codex-live-controls native Interrupt mismatch is expired", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptRpcError: "mismatch",
    steerTerminal: "completed",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), {
    outcome: "rejected",
    reason: "expired",
  });
  assert.deepEqual(await turn.steer({ text: "continue instead" }), {
    outcome: "accepted",
  });
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

test("codex-live-controls does not downgrade a near-miss Interrupt error", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptRpcError: "near-miss",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), {
    outcome: "rejected",
    reason: "expired",
  });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.phase, "control");
  assert.equal(result.detail.failure?.category, "native-control");
  assert.equal(result.detail.failure?.nativeCode, "-32600");
  await prepared.close();
});

test("codex-live-controls native internal control error stays distinct and preserves its code", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptRpcError: "internal",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), {
    outcome: "rejected",
    reason: "expired",
  });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "completion");
  assert.equal(result.detail.failure?.phase, "control");
  assert.equal(result.detail.failure?.category, "native-control");
  assert.equal(result.detail.failure?.nativeCode, "-32603");
  assert.ok(result.detail.failure?.cause instanceof Error);
  await prepared.close();
});

for (const terminal of ["completed", "failed"] as const) {
  test(`codex-live-controls ${terminal} terminal truth wins an interrupt acknowledgement race`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({
      withholdTerminal: true,
      interruptTerminalBeforeResponse: terminal,
    });
    const prepared = await prepareCodex(installed.path);
    const turn = prepared.startTurn(turnRequest());
    await waitForSession(turn);

    assert.deepEqual(await turn.interrupt(), {
      outcome: "rejected",
      reason: "expired",
    });
    assert.equal((await turn.result()).kind, terminal);
    await prepared.close();
  });
}

test("codex-live-controls matching interrupted terminal can confirm before acknowledgement", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptTerminalBeforeResponse: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "interrupted");
  await prepared.close();
});

test("codex-live-controls rejects a mismatched native Steer response as stale", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    mismatchedSteerResponse: true,
    interruptTerminal: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.steer({ text: "stale guidance" }), {
    outcome: "rejected",
    reason: "expired",
  });
  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "interrupted");
  await prepared.close();
});

for (const race of ["no-active", "mismatch"] as const) {
  test(`codex-live-controls rejects the native ${race} Steer race as expired`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({
      withholdTerminal: true,
      steerRpcError: race,
      interruptTerminal: "interrupted",
    });
    const prepared = await prepareCodex(installed.path);
    const turn = prepared.startTurn(turnRequest());
    await waitForSession(turn);

    assert.deepEqual(await turn.steer({ text: "racing guidance" }), {
      outcome: "rejected",
      reason: "expired",
    });
    assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
    assert.equal((await turn.result()).kind, "interrupted");
    await prepared.close();
  });
}

for (const controlCase of [
  { native: "empty", reason: "shape-mismatch" },
  { native: "review", reason: "expired" },
  { native: "compact", reason: "expired" },
  { native: "schema", reason: "expired" },
] as const) {
  test(`codex-live-controls maps native Steer ${controlCase.native} to ${controlCase.reason}`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({
      withholdTerminal: true,
      steerRpcError: controlCase.native,
      interruptTerminal: "interrupted",
    });
    const prepared = await prepareCodex(installed.path);
    const turn = prepared.startTurn(turnRequest());
    await waitForSession(turn);

    assert.deepEqual(await turn.steer({ text: "rejected guidance" }), {
      outcome: "rejected",
      reason: controlCase.reason,
    });
    assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
    assert.equal((await turn.result()).kind, "interrupted");
    await prepared.close();
  });
}

test("codex-live-controls does not downgrade a near-miss native error", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    steerRpcError: "near-miss",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.steer({ text: "must fail closed" }), {
    outcome: "rejected",
    reason: "expired",
  });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.phase, "control");
  assert.equal(result.detail.failure?.category, "native-control");
  assert.equal(result.detail.failure?.nativeCode, "-32600");
  await prepared.close();
});

test("codex-live-controls malformed Steer response fails closed without throwing", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    malformedSteerResponse: true,
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.steer({ text: "invalid response" }), {
    outcome: "rejected",
    reason: "expired",
  });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  assert.equal(result.detail.failure?.phase, "control");
  assert.ok(result.detail.failure?.cause instanceof Error);
  await prepared.close();
});

test("codex-live-controls control timeout preserves its cause on the Turn", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    stallSteerResponse: true,
  });
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    controlTimeoutMs: 1_000,
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const prepared = preparedResult.harness;
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  assert.deepEqual(await turn.steer({ text: "will time out" }), {
    outcome: "rejected",
    reason: "expired",
  });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "control-timeout");
  assert.equal(result.detail.failure?.phase, "control");
  assert.match(
    result.detail.failure?.cause instanceof Error
      ? result.detail.failure.cause.message
      : "",
    /turn\/steer control exchange timed out/,
  );
  await prepared.close();
});

for (const failure of ["malformed", "timeout"] as const) {
  test(`codex-live-controls Interrupt ${failure} is a control failure with interruption unknown`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.configureTurn({
      withholdTerminal: true,
      malformedInterruptResponse: failure === "malformed",
      stallInterruptResponse: failure === "timeout",
    });
    const preparedResult = await createCodexAdapter({
      path: installed.path,
      env: {},
      controlTimeoutMs: 1_000,
    }).prepare({ workspace: process.cwd() });
    assert.equal(preparedResult.ok, true);
    if (!preparedResult.ok) throw new Error("unreachable");
    const prepared = preparedResult.harness;
    const turn = prepared.startTurn(turnRequest());
    await waitForSession(turn);

    assert.deepEqual(await turn.interrupt(), {
      outcome: "rejected",
      reason: "expired",
    });
    const result = await turn.result();
    assert.equal(result.kind, "lost");
    if (result.kind !== "lost") throw new Error("unreachable");
    assert.equal(result.detail.unknown, "interruption");
    assert.equal(result.detail.failure?.phase, "control");
    assert.equal(
      result.detail.failure?.category,
      failure === "malformed" ? "protocol-corruption" : "control-timeout",
    );
    assert.ok(result.detail.failure?.cause instanceof Error);
    await prepared.close();
  });
}

test("codex-live-controls close interrupts live work before app-server shutdown", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    interruptTerminal: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);

  const first = await prepared.close();
  assert.equal((await turn.result()).kind, "interrupted");
  assert.equal(first.clean, true);
  assert.strictEqual(await prepared.close(), first);

  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  assert.equal(
    appServer.stdinLines.at(-1) === undefined
      ? undefined
      : JSON.parse(appServer.stdinLines.at(-1)!).method,
    "turn/interrupt",
  );
});

test("codex-live-controls close stays bounded before a native Turn exists", async () => {
  const installed = installSyntheticCodexReplayer();
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    controlTimeoutMs: 5_000,
    cleanupTimeoutMs: 500,
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const prepared = preparedResult.harness;
  let admissionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    admissionStarted = resolve;
  });
  const turn = prepared.startTurn(
    turnRequest({
      admit: () => {
        admissionStarted();
        return new Promise(() => undefined);
      },
      checkpoint: () => Promise.resolve({ recorded: true }),
    }),
  );
  await started;

  const closeStartedAt = Date.now();
  assert.equal((await prepared.close()).clean, true);
  assert.ok(
    Date.now() - closeStartedAt < 2_000,
    "close must use its cleanup bound before the native Turn exists",
  );
  assert.equal((await turn.result()).kind, "not-started");
});

test("codex-live-controls close bounds an already in-flight Interrupt", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    stallInterruptResponse: true,
  });
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    controlTimeoutMs: 5_000,
    cleanupTimeoutMs: 500,
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const prepared = preparedResult.harness;
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);
  assert.deepEqual(await turn.steer({ text: "establish active target" }), {
    outcome: "accepted",
  });

  const interrupt = turn.interrupt();
  const closeStartedAt = Date.now();
  assert.equal((await prepared.close()).clean, true);
  assert.ok(
    Date.now() - closeStartedAt < 2_000,
    "close must use its cleanup bound instead of the in-flight control bound",
  );
  assert.deepEqual(await interrupt, {
    outcome: "rejected",
    reason: "expired",
  });
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
});

test("codex-live-controls close rejects an in-flight Steer receipt", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({
    withholdTerminal: true,
    stallSecondSteerResponse: true,
    interruptTerminal: "interrupted",
  });
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  await waitForSession(turn);
  assert.deepEqual(await turn.steer({ text: "establish active target" }), {
    outcome: "accepted",
  });

  const racingSteer = turn.steer({ text: "must expire during close" });
  await prepared.close();
  assert.deepEqual(await racingSteer, {
    outcome: "rejected",
    reason: "expired",
  });
  assert.equal((await turn.result()).kind, "interrupted");
});

test("cleanup failure cannot rewrite an already-settled Codex Turn", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.failCleanup(9);
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn(turnRequest());
  const settled = await turn.result();
  assert.equal(settled.kind, "completed");

  const cleanup = await prepared.close();
  assert.equal(cleanup.clean, false);
  assert.strictEqual(await turn.result(), settled);
});

test("codex-exact-thread-recovery acknowledges the same thread before admission and prompt", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  const { prepared, coordinate } = await prepareDetachedCodex(installed);
  const methodsAtAdmission: string[] = [];
  const second = await prepared
    .startTurn({
      ...turnRequest({
        admit: () => {
          const appServer = installed
            .invocations()
            .find((invocation) => invocation.args.join(" ") === "app-server");
          assert.ok(appServer !== undefined);
          methodsAtAdmission.push(
            ...appServer.stdinLines.map(
              (line) => JSON.parse(line).method as string,
            ),
          );
          return Promise.resolve({ recorded: true });
        },
        checkpoint: () => Promise.resolve({ recorded: true }),
      }),
      resume: coordinate,
    })
    .result();

  assert.equal(second.kind, "completed");
  assert.deepEqual(methodsAtAdmission.slice(-1), ["thread/resume"]);
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const runtimeRequests = appServer.stdinLines
    .map((line) => JSON.parse(line))
    .filter((message) =>
      ["thread/start", "thread/resume", "turn/start"].includes(message.method),
    );
  assert.deepEqual(
    runtimeRequests.map((message) => [message.method, message.params.threadId]),
    [
      ["thread/start", undefined],
      ["turn/start", "thread-1"],
      ["thread/resume", "thread-1"],
      ["turn/start", "thread-1"],
    ],
  );
  await prepared.close();
});

test("a newly materialized Codex Session resumes from the caller coordinate without starting fresh", async () => {
  const installed = installSyntheticCodexReplayer();
  const prepared = await prepareCodex(installed.path);
  const result = await prepared
    .startTurn({
      ...turnRequest(),
      resume: { opaque: "thread-1" },
    })
    .result();

  assert.equal(result.kind, "completed");
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const runtimeMethods = appServer.stdinLines
    .map((line) => JSON.parse(line).method)
    .filter(
      (method) => method.startsWith("thread/") || method === "turn/start",
    );
  assert.deepEqual(runtimeMethods, ["thread/resume", "turn/start"]);
  await prepared.close();
});

test("a detached Codex Session recovers its private coordinate when resume is omitted", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  const { prepared } = await prepareDetachedCodex(installed);
  assert.equal(
    (await prepared.startTurn(turnRequest()).result()).kind,
    "completed",
  );
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  assert.equal(
    appServer.stdinLines.filter(
      (line) => JSON.parse(line).method === "thread/resume",
    ).length,
    1,
  );
  await prepared.close();
});

test("a mismatched Codex recovery acknowledgement permanently fences the Session", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  installed.configureRecovery({ threadId: "different-thread" });
  const { prepared, coordinate } = await prepareDetachedCodex(installed);
  let admissions = 0;
  const recorder: DurableTurnRecorder = {
    admit: () => {
      admissions += 1;
      return Promise.resolve({ recorded: true });
    },
    checkpoint: () => Promise.resolve({ recorded: true }),
  };
  const second = await prepared
    .startTurn({
      ...turnRequest(recorder),
      resume: coordinate,
    })
    .result();
  assert.equal(second.kind, "failed");
  if (second.kind !== "failed") throw new Error("unreachable");
  assert.equal(second.detail.failure.phase, "recovery");
  assert.equal(second.detail.failure.category, "recovery-unacknowledged");
  assert.equal(second.detail.failure.possibleEffects, "none");
  assert.equal(second.detail.session.state, "unusable");

  const third = await prepared.startTurn(turnRequest(recorder)).result();
  assert.deepEqual(third, second);
  assert.equal(admissions, 0);
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  const runtimeMethods = appServer.stdinLines
    .map((line) => JSON.parse(line).method)
    .filter((method) =>
      ["thread/start", "thread/resume", "turn/start"].includes(method),
    );
  assert.deepEqual(runtimeMethods, [
    "thread/start",
    "turn/start",
    "thread/resume",
  ]);
  await prepared.close();
});

test("a Codex recovery response without a thread acknowledgement fails before admission", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  installed.configureRecovery({ threadId: null });
  const { prepared, coordinate } = await prepareDetachedCodex(installed);
  let admitted = false;
  const result = await prepared
    .startTurn({
      ...turnRequest({
        admit: () => {
          admitted = true;
          return Promise.resolve({ recorded: true });
        },
        checkpoint: () => Promise.resolve({ recorded: true }),
      }),
      resume: coordinate,
    })
    .result();

  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") throw new Error("unreachable");
  assert.equal(result.detail.failure.phase, "recovery");
  assert.equal(result.detail.failure.category, "recovery-unacknowledged");
  assert.ok(result.detail.failure.cause instanceof Error);
  assert.equal(result.detail.session.state, "unusable");
  assert.equal(admitted, false);
  await prepared.close();
});

test("malformed transport during Codex recovery is a sticky recovery failure", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  installed.configureRecovery({ malformedFrame: true });
  const { prepared, coordinate } = await prepareDetachedCodex(installed);
  const failed = await prepared
    .startTurn({
      ...turnRequest(),
      resume: coordinate,
    })
    .result();

  assert.equal(failed.kind, "failed");
  if (failed.kind !== "failed") throw new Error("unreachable");
  assert.equal(failed.detail.failure.phase, "recovery");
  assert.equal(failed.detail.failure.category, "recovery-unacknowledged");
  assert.equal(failed.detail.session.state, "unusable");
  assert.ok(failed.detail.failure.cause instanceof Error);
  assert.deepEqual(await prepared.startTurn(turnRequest()).result(), failed);
  await prepared.close();
});

test("a detached Codex Session cannot be rebound to another recovery coordinate", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true, stopAfter: "accepted" });
  installed.configureRecovery({ threadId: "different-thread" });
  const { prepared } = await prepareDetachedCodex(installed);
  const failed = await prepared
    .startTurn({
      ...turnRequest(),
      resume: { opaque: "different-thread" },
    })
    .result();

  assert.equal(failed.kind, "failed");
  if (failed.kind !== "failed") throw new Error("unreachable");
  assert.equal(failed.detail.failure.phase, "recovery");
  assert.equal(failed.detail.session.state, "unusable");
  const appServer = installed
    .invocations()
    .find((invocation) => invocation.args.join(" ") === "app-server");
  assert.ok(appServer !== undefined);
  assert.equal(
    appServer.stdinLines.some(
      (line) => JSON.parse(line).method === "thread/resume",
    ),
    false,
  );
  await prepared.close();
});

async function prepareDetachedCodex(
  installed: InstalledCodexReplayer,
): Promise<{
  readonly prepared: PreparedHarness;
  readonly coordinate: RecoveryCoordinate;
}> {
  const preparedResult = await createCodexAdapter({
    path: installed.path,
    env: {},
    controlTimeoutMs: 500,
  }).prepare({ workspace: process.cwd() });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const prepared = preparedResult.harness;
  const first = await prepared.startTurn(turnRequest()).result();
  assert.equal(first.kind, "lost");
  if (first.kind !== "lost" || first.detail.session.state !== "detached") {
    throw new Error("unreachable");
  }
  return { prepared, coordinate: first.detail.session.coordinate };
}

async function prepareCodex(path: string): Promise<PreparedHarness> {
  const result = await createCodexAdapter({ path, env: {} }).prepare({
    workspace: process.cwd(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.harness;
}

function turnRequest(
  recorder: DurableTurnRecorder = successfulRecorder(),
  overrides?: { readonly text?: string; readonly session?: string },
): TurnRequest {
  return {
    session: overrides?.session ?? "codex-test",
    origin: "managed",
    correlationKey: { opaque: "codex-correlation" },
    recorder,
    input: { text: overrides?.text ?? "private prompt" },
  };
}

function successfulRecorder(): DurableTurnRecorder {
  return {
    admit: () => Promise.resolve({ recorded: true }),
    checkpoint: () => Promise.resolve({ recorded: true }),
  };
}

function observeEvents(
  turn: ReturnType<PreparedHarness["startTurn"]>,
): TurnEvent[] {
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  return events;
}

function waitForSession(
  turn: ReturnType<PreparedHarness["startTurn"]>,
): Promise<void> {
  return new Promise((resolve) => {
    turn.subscribe((event) => {
      if (event.kind === "session") resolve();
    });
  });
}

async function waitForRequestCount(
  turn: ReturnType<PreparedHarness["startTurn"]>,
  events: readonly TurnEvent[],
  count: number,
): Promise<void> {
  await waitForEventCount(turn, events, "request-raised", count);
}

async function waitForExpiredRequestCount(
  turn: ReturnType<PreparedHarness["startTurn"]>,
  events: readonly TurnEvent[],
  count: number,
): Promise<void> {
  await waitForEventCount(turn, events, "request-expired", count);
}

async function waitForEventCount(
  turn: ReturnType<PreparedHarness["startTurn"]>,
  events: readonly TurnEvent[],
  kind: TurnEvent["kind"],
  count: number,
): Promise<void> {
  if (events.filter((event) => event.kind === kind).length >= count) return;
  await new Promise<void>((resolve) => {
    const subscription = turn.subscribe(() => {
      if (events.filter((event) => event.kind === kind).length < count) return;
      subscription.unsubscribe();
      resolve();
    });
  });
}

test("[codex-recorded-conformance] qualification initializes once without creating a conversation", async () => {
  const installed = installCodexReplayer("codex-qualification");
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const invocations = installed.invocations();
  assert.deepEqual(
    invocations.map((invocation) => invocation.args),
    [
      ["--version"],
      ["app-server", "generate-json-schema", "--out", invocations[1]?.args[3]],
      ["app-server"],
    ],
  );

  const appServer = invocations[2];
  assert.ok(appServer !== undefined);
  const messages = appServer.stdinLines.map((line) => JSON.parse(line));
  assert.deepEqual(
    messages.map((message) => message.method),
    ["initialize", "initialized", "account/read", "model/list"],
  );
  assert.equal(
    messages.filter((message) => message.method === "initialize").length,
    1,
  );
  assert.equal(messages[0]?.params.capabilities?.experimentalApi, false);
  assert.ok(
    messages.every(
      (message) =>
        !message.method.startsWith("thread/") &&
        !message.method.startsWith("turn/") &&
        message.params?.input === undefined,
    ),
  );
  const recordedCase = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "fixtures",
        "codex",
        "codex-qualification",
        "case.json",
      ),
      "utf8",
    ),
  );
  const recordedStdin = recordedCase.traffic
    .filter((entry: { direction: string }) => entry.direction === "stdin")
    .map((entry: { line: string }) => entry.line);
  assert.deepEqual(
    appServer.stdinLines.map((line) => `${line}\n`),
    recordedStdin,
  );

  await result.harness.close();
});

test("the recorder observer captures runtime traffic and shutdown through the production Adapter", async () => {
  const installed = installSyntheticCodexReplayer();
  const observed: {
    direction: "stdin" | "stdout" | "stderr";
    line: string;
  }[] = [];
  const closes: { kind: string; status: number | undefined }[] = [];
  let schemaBytes = 0;
  let executableVersion: string | undefined;
  let protocolVersion: string | undefined;
  const decoder = new TextDecoder();
  const observer: CodexRecordingObserver = {
    version(version) {
      executableVersion = version;
    },
    schema(schema, revision) {
      schemaBytes = Buffer.byteLength(schema);
      protocolVersion = revision;
    },
    stdin(bytes) {
      observed.push({ direction: "stdin", line: decoder.decode(bytes) });
    },
    stdout(bytes) {
      observed.push({ direction: "stdout", line: decoder.decode(bytes) });
    },
    stderr(bytes) {
      observed.push({ direction: "stderr", line: decoder.decode(bytes) });
    },
    closed(kind, status) {
      closes.push({ kind, status });
    },
  };
  const prepared = await createCodexAdapter({
    path: installed.path,
    env: {},
    recordingObserver: observer,
  }).prepare({ workspace: process.cwd() });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const result = await prepared.harness.startTurn(turnRequest()).result();
  assert.equal(result.kind, "completed");
  await prepared.harness.close();

  const runtimeMethods = observed
    .filter((entry) => entry.direction === "stdin")
    .map((entry) => JSON.parse(entry.line).method)
    .filter(
      (method) => method?.startsWith("thread/") || method?.startsWith("turn/"),
    );
  assert.deepEqual(runtimeMethods, ["thread/start", "turn/start"]);
  assert.equal(executableVersion, "codex-cli 0.155.0");
  assert.equal(protocolVersion, "codex-probe-2");
  assert.ok(schemaBytes > 0);
  assert.ok(
    observed.some(
      (entry) =>
        entry.direction === "stdout" &&
        JSON.parse(entry.line).method === "turn/completed",
    ),
  );
  assert.deepEqual(closes, [{ kind: "exited", status: 0 }]);

  const failedCapture = createCodexRecordingCapture();
  const failed = await createCodexAdapter({
    path: installCodexReplayer("authentication").path,
    env: {},
    recordingObserver: failedCapture.observer,
  }).prepare({ workspace: process.cwd() });
  assert.equal(failed.ok, false);
  assert.deepEqual(failedCapture.exit, { kind: "exited", status: 0 });

  const stderrCapture = createCodexRecordingCapture();
  const stderrPreparedResult = await createCodexAdapter({
    path: installCodexReplayer("interrupt").path,
    env: {},
    recordingObserver: stderrCapture.observer,
  }).prepare({ workspace: process.cwd() });
  assert.equal(stderrPreparedResult.ok, true);
  if (!stderrPreparedResult.ok) throw new Error("unreachable");
  const stderrTurn = stderrPreparedResult.harness.startTurn(
    recordedSleepRequest("interrupt"),
  );
  const stderrEvents = observeEvents(stderrTurn);
  await waitForToolOrRequest(stderrTurn, stderrEvents);
  await stderrTurn.interrupt();
  await stderrTurn.result();
  await stderrPreparedResult.harness.close();
  assert.ok(
    stderrCapture.traffic.some(
      (entry) => entry.direction === "stderr" && entry.line.length > 0,
    ),
  );
});

test("[codex-recorded-conformance] completion replays exact client traffic", async () => {
  const installed = installCodexReplayer("completion");
  const prepared = await prepareCodex(installed.path);
  const turn = prepared.startTurn({
    ...turnRequest(),
    session: "completion",
    correlationKey: { opaque: "record-completion" },
    input: { text: CODEX_RECORDING_INPUT.completion },
  });
  const events = observeEvents(turn);
  const result = await turn.result();
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  assert.equal(result.detail.finalContent, "recorded completion.");
  assert.equal(result.detail.effectiveModel.known, true);
  assert.ok(events.some((event) => event.kind === "preview"));
  assert.deepEqual(
    events.filter((event) => event.kind === "assistant-content"),
    [{ kind: "assistant-content", content: "recorded completion." }],
  );
  const replayed: TurnEvent[] = [];
  turn.subscribe((event) => replayed.push(event));
  assert.ok(replayed.every((event) => event.kind !== "preview"));
  await prepared.close();
  assert.deepEqual(
    installed
      .invocations()
      .find((invocation) => invocation.args.join(" ") === "app-server")
      ?.stdinLines.map((line) => JSON.parse(line).method),
    [
      "initialize",
      "initialized",
      "account/read",
      "model/list",
      "thread/start",
      "turn/start",
    ],
  );
});

test("strict Codex replay refuses client traffic that diverges from recorded bytes", async () => {
  const prepared = await prepareCodex(installCodexReplayer("completion").path);
  const result = await prepared
    .startTurn({
      ...turnRequest(),
      session: "completion",
      correlationKey: { opaque: "record-completion" },
      input: { text: "different unrecorded input" },
    })
    .result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "acceptance");
  await prepared.close();
});

test("[codex-recorded-conformance] native Steer replays its exact active Turn", async () => {
  const prepared = await prepareCodex(installCodexReplayer("steer").path);
  const turn = prepared.startTurn({
    ...turnRequest(),
    session: "steer",
    correlationKey: { opaque: "record-steer" },
    input: {
      text: CODEX_RECORDING_INPUT.steer,
    },
  });
  await waitForSession(turn);
  assert.deepEqual(
    await turn.steer({ text: CODEX_RECORDING_INPUT.steerGuidance }),
    { outcome: "accepted" },
  );
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

test("[codex-recorded-conformance] approval exposes the action and replays allow once", async () => {
  const prepared = await prepareCodex(installCodexReplayer("approval").path);
  const turn = prepared.startTurn({
    ...turnRequest(),
    session: "approval",
    correlationKey: { opaque: "record-approval" },
    input: {
      text: CODEX_RECORDING_INPUT.approval,
    },
  });
  const events = observeEvents(turn);
  await waitForRequestCount(turn, events, 1);
  const raised = events.find((event) => event.kind === "request-raised");
  assert.equal(raised?.kind, "request-raised");
  if (raised?.kind !== "request-raised") throw new Error("unreachable");
  assert.equal(raised.request.shape.kind, "approval");
  if (raised.request.shape.kind !== "approval") throw new Error("unreachable");
  assert.match(
    raised.request.shape.input,
    /touch \/tmp\/secant-codex-recording-approval/,
  );
  assert.deepEqual(
    await turn.answerRequest({
      requestId: raised.request.requestId,
      kind: "approval",
      decision: "allow",
    }),
    { outcome: "accepted" },
  );
  assert.equal((await turn.result()).kind, "completed");
  await prepared.close();
});

test("[codex-recorded-conformance] Interrupt waits for recorded terminal truth", async () => {
  const prepared = await prepareCodex(installCodexReplayer("interrupt").path);
  const turn = prepared.startTurn(recordedSleepRequest("interrupt"));
  const events = observeEvents(turn);
  await waitForToolOrRequest(turn, events);
  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "interrupted");
  await prepared.close();
});

test("[codex-recorded-conformance] Resume reattaches the exact recorded thread", async () => {
  const prepared = await prepareCodex(installCodexReplayer("resume").path);
  const first = prepared.startTurn(recordedSleepRequest("resume"));
  const events = observeEvents(first);
  await waitForToolOrRequest(first, events);
  assert.deepEqual(await first.interrupt(), { outcome: "accepted" });
  const interrupted = await first.result();
  assert.equal(interrupted.kind, "interrupted");
  if (
    interrupted.kind !== "interrupted" ||
    interrupted.detail.session.state !== "detached"
  ) {
    throw new Error("unreachable");
  }
  const second = prepared.startTurn({
    ...turnRequest(),
    session: "resume",
    correlationKey: { opaque: "record-resume" },
    input: { text: CODEX_RECORDING_INPUT.resume },
    resume: interrupted.detail.session.coordinate,
  });
  assert.equal((await second.result()).kind, "completed");
  await prepared.close();
});

test("[codex-recorded-conformance] authentication stays a typed prepare failure", async () => {
  const result = await createCodexAdapter({
    path: installCodexReplayer("authentication").path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "authentication");
  assert.match(
    result.failure.diagnostics ?? "",
    /Log in separately through Codex/,
  );
});

test("[codex-recorded-conformance] synthetic incompatible init fails closed", async () => {
  const result = await createCodexAdapter({
    path: installCodexReplayer("incompatibility").path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(
    result.failure.diagnostics ?? "",
    /initialize returned an incompatible result/,
  );
});

test("[codex-recorded-conformance] Test Repair applies its recorded Workspace patch", async () => {
  const workspace = makeTempDir("secant-codex-recorded-repair-");
  seedTestRepairWorkspace(workspace);
  const preparedResult = await createCodexAdapter({
    path: installCodexReplayer("test-repair").path,
    env: {},
  }).prepare({ workspace });
  assert.equal(preparedResult.ok, true);
  if (!preparedResult.ok) throw new Error("unreachable");
  const result = await preparedResult.harness
    .startTurn({
      ...turnRequest(),
      session: "test-repair",
      correlationKey: { opaque: "record-test-repair" },
      input: { text: codexTestRepairPrompt(workspace) },
    })
    .result();
  assert.equal(result.kind, "completed", JSON.stringify(result));
  execFileSync(process.execPath, ["test", "sum.test.mjs"], {
    cwd: workspace,
    stdio: "pipe",
  });
  await preparedResult.harness.close();
});

function recordedSleepRequest(session: "interrupt" | "resume"): TurnRequest {
  return {
    ...turnRequest(),
    session,
    correlationKey: { opaque: `record-${session}` },
    input: {
      text: CODEX_RECORDING_INPUT.sleep,
    },
  };
}

async function waitForToolOrRequest(
  turn: ReturnType<PreparedHarness["startTurn"]>,
  events: readonly TurnEvent[],
): Promise<void> {
  if (
    events.some(
      (event) =>
        event.kind === "tool-activity" || event.kind === "request-raised",
    )
  ) {
    return;
  }
  await new Promise<void>((resolve) => {
    const subscription = turn.subscribe((event) => {
      if (event.kind !== "tool-activity" && event.kind !== "request-raised") {
        return;
      }
      subscription.unsubscribe();
      resolve();
    });
  });
}

test("configured Codex wins over PATH and Claude Code is never a fallback", async () => {
  const configured = installSyntheticCodexReplayer();
  const onPath = installSyntheticCodexReplayer();
  onPath.drift("codex-cli 0.146.0");
  const result = await createCodexAdapter({
    path: onPath.path,
    env: { [CODEX_EXECUTABLE_ENV]: configured.executablePath },
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.harness.profile.executableVersion, "codex-cli 0.155.0");
  assert.match(result.harness.profile.executable, /configured command/);
  await result.harness.close();

  const missing = await createCodexAdapter({
    path: makeTempDir("secant-codex-no-fallback-"),
    env: {},
    resolve: () => undefined,
  }).prepare({ workspace: process.cwd() });
  assert.equal(missing.ok, false);
  if (missing.ok) throw new Error("unreachable");
  assert.equal(missing.failure.category, "not-found");
  assert.match(missing.failure.diagnostics ?? "", /PATH name 'codex'/);
  assert.doesNotMatch(missing.failure.diagnostics ?? "", /Claude/);
});

test("an unsupported Windows shim is a typed Codex outcome", async () => {
  const directory = makeTempDir("secant-codex-shim-");
  const shim = join(directory, "codex.cmd");
  writeFileSync(shim, "@echo off\r\necho unsupported\r\n");
  const result = await createCodexAdapter({
    platform: "win32",
    env: {},
    resolve: (name) => (name === "codex" ? shim : undefined),
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "unsupported-shim");
});

test("an unsupported host platform is a typed Codex outcome", async () => {
  const result = await createCodexAdapter({
    platform: "aix",
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "unsupported-platform");
});

test("Codex profile is truthful and user-compatible", async () => {
  const installed = installSyntheticCodexReplayer();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const { profile } = result.harness;
  assert.equal(profile.harness, "codex");
  assert.equal(profile.adapterRevision, "codex-probe-2");
  assert.equal(profile.recovery.mode, "native-reattach");
  assert.match(profile.recovery.evidence, /thread\/resume.*exact/i);
  assert.equal(profile.interruption.mode, "active-turn");
  assert.equal(profile.approvals.available, true);
  assert.equal(profile.clarifications.available, false);
  assert.equal(profile.steer.available, true);
  assert.equal(profile.modelSelection.at, "launch-and-per-turn");
  assert.equal(profile.recoveryCoordinate.timing, "before-submission");
  assert.equal(profile.skillDelivery.mode, "plain-path");
  assert.equal(profile.fileDelivery.mode, "plain-path");
  assert.match(profile.configurationPosture, /user-compatible/);
  assert.match(profile.configurationPosture, /experimental.*disabled/i);
  await result.harness.close();
});

test("required schema drift fails closed before app-server launch", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.removeSchemaMethod("turn/completed");
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /turn\/completed/);
  assert.equal(
    installed
      .invocations()
      .filter(
        (invocation) =>
          invocation.args.length === 1 && invocation.args[0] === "app-server",
      ).length,
    0,
  );
});

test("a changed required schema field type fails closed", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.changeTurnStatusShape();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /Turn status/);
});

for (const field of [
  "path",
  "kind",
  "move-path",
  "file-items",
  "command",
  "command-kind",
  "resolved-id",
  "resolved-thread",
  "command-kind-values",
  "request-id-types",
  "server-request-id",
] as const) {
  test(`changed approval ${field} schema fails qualification closed`, async () => {
    const installed = installSyntheticCodexReplayer();
    installed.changeApprovalSchemaShape(field);
    const result = await createCodexAdapter({
      path: installed.path,
      env: {},
    }).prepare({ workspace: process.cwd() });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.failure.category, "protocol-incompatible");
    assert.match(
      result.failure.diagnostics ?? "",
      /file.?change|command approval|request resolution|request id|server request/i,
    );
  });
}

test("version and generated-schema probe failures stay typed", async () => {
  const versionFailure = installSyntheticCodexReplayer();
  versionFailure.failVersion(7);
  const versionResult = await createCodexAdapter({
    path: versionFailure.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(versionResult.ok, false);
  if (versionResult.ok) throw new Error("unreachable");
  assert.equal(versionResult.failure.category, "version-probe");
  assert.equal(versionResult.failure.nativeCode, "7");

  const malformedSchema = installSyntheticCodexReplayer();
  malformedSchema.corruptSchema();
  const schemaResult = await createCodexAdapter({
    path: malformedSchema.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(schemaResult.ok, false);
  if (schemaResult.ok) throw new Error("unreachable");
  assert.equal(schemaResult.failure.category, "protocol-incompatible");
  assert.ok(schemaResult.failure.cause instanceof Error);
});

test("required live response drift fails closed and reaps the child", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.removeResponseField("model/list", "data");
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /model\/list/);
  const appServer = installed
    .invocations()
    .find(
      (invocation) =>
        invocation.args.length === 1 && invocation.args[0] === "app-server",
    );
  assert.ok(appServer !== undefined);
  assert.deepEqual(
    appServer.stdinLines.map((line) => JSON.parse(line).method),
    ["initialize", "initialized", "account/read", "model/list"],
  );
});

test("a child that stops draining stdin cannot outlive the handshake bound", async () => {
  const installed = installSyntheticCodexReplayer();
  const stalled = stalledProcess();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
    handshakeTimeoutMs: 20,
    spawn: () => Promise.resolve({ ok: true, process: stalled }),
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /timed out/);
});

test("a notification flood cannot extend the whole-RPC deadline", async () => {
  const installed = installSyntheticCodexReplayer();
  const flooding = notificationFloodProcess();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
    handshakeTimeoutMs: 20,
    spawn: () => Promise.resolve({ ok: true, process: flooding }),
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.failure.diagnostics ?? "", /initialize.*timed out/);
});

test("app-server launch and cleanup failures preserve their own evidence", async () => {
  const launchReplayer = installSyntheticCodexReplayer();
  const launchCause = new Error("scripted app-server launch failure");
  const launchResult = await createCodexAdapter({
    path: launchReplayer.path,
    env: {},
    spawn: () =>
      Promise.resolve({
        ok: false,
        failure: { kind: "spawn-error", cause: launchCause },
      }),
  }).prepare({ workspace: process.cwd() });
  assert.equal(launchResult.ok, false);
  if (launchResult.ok) throw new Error("unreachable");
  assert.equal(launchResult.failure.category, "app-server-launch");
  assert.equal(launchResult.failure.cause, launchCause);

  const cleanupReplayer = installSyntheticCodexReplayer();
  cleanupReplayer.failCleanup(9);
  const prepared = await createCodexAdapter({
    path: cleanupReplayer.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");
  const first = await prepared.harness.close();
  assert.equal(first.clean, false);
  assert.equal(first.failure?.category, "cleanup");
  assert.strictEqual(await prepared.harness.close(), first);

  const evidenceReplayer = installSyntheticCodexReplayer();
  const stderrCause = new Error("scripted stderr read failure");
  const cleanupCause = new Error("scripted cleanup failure");
  const evidenceProcess = qualificationProcess({ stderrCause, cleanupCause });
  const evidencePrepared = await createCodexAdapter({
    path: evidenceReplayer.path,
    env: {},
    spawn: () => Promise.resolve({ ok: true, process: evidenceProcess }),
  }).prepare({ workspace: process.cwd() });
  assert.equal(evidencePrepared.ok, true);
  if (!evidencePrepared.ok) throw new Error("unreachable");
  const evidence = await evidencePrepared.harness.close();
  assert.equal(evidence.clean, false);
  assert.ok(evidence.failure?.cause instanceof AggregateError);
  assert.deepEqual(evidence.failure.cause.errors, [cleanupCause, stderrCause]);
});

test("authentication remains Codex-owned with separate-login remediation", async () => {
  const installed = installSyntheticCodexReplayer();
  installed.requireLogin();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "authentication");
  assert.match(
    result.failure.diagnostics ?? "",
    /Log in separately through Codex/,
  );
  assert.doesNotMatch(result.failure.diagnostics ?? "", /recorded@example/);

  const appServer = installed
    .invocations()
    .find(
      (invocation) =>
        invocation.args.length === 1 && invocation.args[0] === "app-server",
    );
  assert.ok(appServer !== undefined);
  assert.deepEqual(
    appServer.stdinLines.map((line) => JSON.parse(line).method),
    ["initialize", "initialized", "account/read"],
  );
});

test("cached schema evidence is reused but every prepare initializes a fresh child", async () => {
  const installed = installSyntheticCodexReplayer();
  const adapter = createCodexAdapter({ path: installed.path, env: {} });
  const first = await adapter.prepare({ workspace: process.cwd() });
  const second = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) throw new Error("unreachable");

  const invocations = installed.invocations();
  assert.equal(
    invocations.filter((invocation) =>
      invocation.args.includes("generate-json-schema"),
    ).length,
    1,
  );
  assert.equal(
    invocations.filter(
      (invocation) =>
        invocation.args.length === 1 && invocation.args[0] === "app-server",
    ).length,
    2,
  );
  await first.harness.close();
  await second.harness.close();

  installed.driftBytesWithoutMetadataChange();
  const byteDrifted = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(byteDrifted.ok, true);
  if (!byteDrifted.ok) throw new Error("unreachable");
  assert.equal(
    installed
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    2,
  );
  await byteDrifted.harness.close();

  installed.drift("codex-cli 0.155.0");
  const drifted = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(drifted.ok, true);
  if (!drifted.ok) throw new Error("unreachable");
  assert.equal(drifted.harness.profile.executableVersion, "codex-cli 0.155.0");
  assert.equal(
    installed
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    3,
  );
  await drifted.harness.close();
});

test("cache evidence invalidates on source, path, version, platform, and probe revision", async () => {
  const installed = installSyntheticCodexReplayer();
  let cachePlatform: HarnessPlatform = "windows";
  let probeRevision = "codex-probe-2";
  const adapter = createCodexAdapter({
    path: installed.path,
    env: {},
    platform: "win32",
    qualificationCachePlatform: () => cachePlatform,
    probeRevision: () => probeRevision,
    resolve(name) {
      if (name === "codex") return installed.executablePath;
      if (name === "bun") return process.execPath;
      if (name.endsWith("codex.cmd")) return name;
      return undefined;
    },
  });

  const prepared: { harness: { close(): Promise<unknown> } }[] = [];
  const qualify = async (configuredExecutable?: string): Promise<void> => {
    const options: { workspace: string; configuredExecutable?: string } = {
      workspace: process.cwd(),
    };
    if (configuredExecutable !== undefined) {
      options.configuredExecutable = configuredExecutable;
    }
    const result = await adapter.prepare(options);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    prepared.push(result);
  };

  await qualify();
  await qualify(installed.windowsShimPath);
  installed.changeVersionOnly("codex-cli 0.154.1");
  await qualify(installed.windowsShimPath);
  cachePlatform = "linux";
  await qualify(installed.windowsShimPath);
  probeRevision = "codex-probe-3";
  await qualify(installed.windowsShimPath);

  const another = installSyntheticCodexReplayer();
  await qualify(another.windowsShimPath);
  assert.equal(
    installed
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    5,
  );
  assert.equal(
    another
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    1,
  );
  await Promise.all(prepared.map((result) => result.harness.close()));
});

function stalledProcess(): OwnedProcess {
  const noBytes = async function* (): AsyncIterable<Uint8Array> {};
  const never = new Promise<void>(() => undefined);
  return {
    stdout: noBytes(),
    stderr: noBytes(),
    writeStdin: () => never,
    closeStdin: () => Promise.resolve({ kind: "exited", status: 0 }),
    interrupt: () =>
      Promise.resolve({
        close: { kind: "exited", status: 0 },
        escalated: false,
      }),
    closed: () => Promise.resolve({ kind: "exited", status: 0 }),
  };
}

interface TControlledApprovalProcess {
  readonly process: OwnedProcess;
  readonly responseWriteStarted: Promise<void>;
  emitResolution(): void;
  emitTerminal(): void;
  releaseResponseWrite(): void;
  rejectResponseWrite(cause: unknown): void;
}

function approvalRaceProcess(): TControlledApprovalProcess {
  const output = asyncByteQueue();
  const responseWriteStarted = deferred<void>();
  const responseWrite = deferred<void>();
  const encoder = new TextEncoder();
  const enqueue = (message: object): void => {
    output.push(encoder.encode(`${JSON.stringify(message)}\n`));
  };
  const writeStdin = (bytes: Uint8Array): Promise<void> => {
    const message = JSON.parse(new TextDecoder().decode(bytes));
    switch (message.method) {
      case "initialize":
        enqueue({
          id: message.id,
          result: {
            userAgent: "recorded",
            codexHome: "/recorded",
            platformFamily: "unix",
            platformOs: "linux",
          },
        });
        return Promise.resolve();
      case "initialized":
        return Promise.resolve();
      case "account/read":
        enqueue({
          id: message.id,
          result: {
            account: { type: "apiKey" },
            requiresOpenaiAuth: true,
          },
        });
        return Promise.resolve();
      case "model/list":
        enqueue({
          id: message.id,
          result: {
            data: [
              {
                id: "model",
                model: "model",
                displayName: "Model",
                hidden: false,
                isDefault: true,
              },
            ],
          },
        });
        return Promise.resolve();
      case "thread/start":
        enqueue({
          id: message.id,
          result: { model: "model", thread: { id: "thread-1" } },
        });
        return Promise.resolve();
      case "turn/start":
        enqueue({
          id: "native-approval",
          method: "item/commandExecution/requestApproval",
          params: {
            command: "bun test",
            itemId: "command-1",
            kind: "command",
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
          },
        });
        enqueue({
          id: message.id,
          result: { turn: { id: "turn-1", items: [], status: "inProgress" } },
        });
        return Promise.resolve();
      default:
        if (message.id === "native-approval" && message.result !== undefined) {
          responseWriteStarted.resolve();
          return responseWrite.promise;
        }
        return Promise.resolve();
    }
  };
  const noBytes = async function* (): AsyncIterable<Uint8Array> {};
  const process: OwnedProcess = {
    stdout: output.iterable,
    stderr: noBytes(),
    writeStdin,
    closeStdin: () => {
      output.end();
      return Promise.resolve({ kind: "exited", status: 0 });
    },
    interrupt: () =>
      Promise.resolve({
        close: { kind: "exited", status: 0 },
        escalated: false,
      }),
    closed: () => Promise.resolve({ kind: "exited", status: 0 }),
  };
  return {
    process,
    responseWriteStarted: responseWriteStarted.promise,
    emitResolution() {
      enqueue({
        method: "serverRequest/resolved",
        params: { requestId: "native-approval", threadId: "thread-1" },
      });
    },
    emitTerminal() {
      enqueue({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", items: [], status: "completed" },
        },
      });
    },
    releaseResponseWrite: () => responseWrite.resolve(),
    rejectResponseWrite: (cause) => responseWrite.reject(cause),
  };
}

interface TDeferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}

function deferred<T>(): TDeferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function asyncByteQueue(): {
  readonly iterable: AsyncIterable<Uint8Array>;
  push(bytes: Uint8Array): void;
  end(): void;
} {
  const buffered: Uint8Array[] = [];
  const waiting: ((result: IteratorResult<Uint8Array>) => void)[] = [];
  let ended = false;
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            const bytes = buffered.shift();
            if (bytes !== undefined) {
              return Promise.resolve({ done: false, value: bytes });
            }
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => waiting.push(resolve));
          },
        };
      },
    },
    push(bytes) {
      const resolve = waiting.shift();
      if (resolve !== undefined) resolve({ done: false, value: bytes });
      else buffered.push(bytes);
    },
    end() {
      ended = true;
      for (const resolve of waiting.splice(0)) {
        resolve({ done: true, value: undefined });
      }
    },
  };
}

function notificationFloodProcess(): OwnedProcess {
  let closed = false;
  const stdout = async function* (): AsyncIterable<Uint8Array> {
    while (!closed) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (closed) return;
      yield new TextEncoder().encode(
        `${JSON.stringify({ method: "account/updated", params: {} })}\n`,
      );
    }
  };
  const noBytes = async function* (): AsyncIterable<Uint8Array> {};
  return {
    stdout: stdout(),
    stderr: noBytes(),
    writeStdin: () => Promise.resolve(),
    closeStdin: () => {
      closed = true;
      return Promise.resolve({ kind: "exited", status: 0 });
    },
    interrupt: () =>
      Promise.resolve({
        close: { kind: "exited", status: 0 },
        escalated: false,
      }),
    closed: () => Promise.resolve({ kind: "exited", status: 0 }),
  };
}

interface TQualificationProcess {
  readonly stderrCause: Error;
  readonly cleanupCause: Error;
}

function qualificationProcess(options: TQualificationProcess): OwnedProcess {
  const encoder = new TextEncoder();
  const stdout = async function* (): AsyncIterable<Uint8Array> {
    yield encoder.encode(
      `${JSON.stringify({ id: 1, result: { userAgent: "recorded", codexHome: "/recorded", platformFamily: "unix", platformOs: "linux" } })}\n`,
    );
    yield encoder.encode(
      `${JSON.stringify({ id: 2, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } })}\n`,
    );
    yield encoder.encode(
      `${JSON.stringify({ id: 3, result: { data: [{ id: "model", model: "model", displayName: "Model", hidden: false, isDefault: true }] } })}\n`,
    );
  };
  const stderr: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(options.stderrCause),
      };
    },
  };
  return {
    stdout: stdout(),
    stderr,
    writeStdin: () => Promise.resolve(),
    closeStdin: () =>
      Promise.resolve({
        kind: "cleanup-error",
        cause: options.cleanupCause,
      }),
    interrupt: () =>
      Promise.resolve({
        close: { kind: "cleanup-error", cause: options.cleanupCause },
        escalated: true,
      }),
    closed: () =>
      Promise.resolve({
        kind: "cleanup-error",
        cause: options.cleanupCause,
      }),
  };
}
