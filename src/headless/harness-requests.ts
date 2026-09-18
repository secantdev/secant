import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type {
  ApprovalDecisionName,
  Problem,
  ProjectionPort,
} from "../application/projection-port.js";

// The one owner of the headless `--harness-requests` policy (A34): the option, its
// parser, the live-Run follower, and the start-before-settlement wrapper both `run
// launch` and `run resume` share. The option was declared verbatim on both commands and
// the follower was wrapped in an identical try/finally in each; moved here so there is
// one declaration, one parser, and one follower. Code moved verbatim from run-commands.ts.

/** The policy an unattended headless Run answers each outstanding approval Harness
 *  Request by while following a live Run (#117). Default `deny`: an unattended
 *  headless Run denies every tool approval unless the operator opts into `allow`. */
export type HarnessRequestPolicy = ApprovalDecisionName;

/** Declare the `--harness-requests` option on a command (verbatim on `run launch` and
 *  `run resume`, A34), defaulting to `deny`. */
export function addHarnessRequestsOption(command: Command): Command {
  return command.option(
    "--harness-requests <policy>",
    "answer each approval Harness Request by this policy: allow or deny",
    "deny",
  );
}

/** Parse `--harness-requests`, defaulting to `deny`. Only `allow`/`deny` are
 *  legal — Claude Code offers no "always". */
export function parseHarnessRequestPolicy(
  value: string | undefined,
): { policy: HarnessRequestPolicy } | { problem: Problem } {
  if (value === undefined || value === "deny") return { policy: "deny" };
  if (value === "allow") return { policy: "allow" };
  return {
    problem: {
      code: "invalid-harness-requests",
      explanation: `--harness-requests "${value}" is not a valid policy.`,
      remediation:
        "Pass `--harness-requests allow` or `--harness-requests deny`.",
      possibleEffects: "none",
    },
  };
}

/** Follow a live Run and answer each outstanding approval Harness Request by the
 *  declared policy (#117). Opens the `run` Projection alongside the driving
 *  Operation's settlement, and on each `live` overlay submits `answer-harness-request`
 *  (as `client-policy`) for every offer not yet attempted at its generation — a
 *  request re-offered at a later generation (a prior answer went stale) is retried.
 *  The answer reaches the live Turn and unblocks it, so the Run can rest. `stop`
 *  closes the follower once the Run settles. Harmless for a Command-only Run: it
 *  sees no overlay and answers nothing. */
export function followHarnessRequests(
  port: ProjectionPort,
  runId: string,
  policy: HarnessRequestPolicy,
): { stop: () => void } {
  const opened = port.openProjection({ family: "run", runId });
  const attempted = new Set<string>();
  let stopped = false;
  const loop = async (): Promise<void> => {
    for await (const update of opened.updates) {
      if (stopped) break;
      if (update.kind !== "live") continue;
      for (const offer of update.overlay.offers) {
        const key = `${offer.generation}:${offer.requestId}`;
        if (attempted.has(key)) continue;
        attempted.add(key);
        // Fire-and-forget: the answer settles inline in this process and unblocks
        // the Turn; the follower stays responsive for the next request.
        port.submit({
          operationId: randomUUID(),
          operation: "answer-harness-request",
          input: {
            runId,
            requestId: offer.requestId,
            generation: offer.generation,
            decision: policy,
            by: "client-policy",
          },
        });
      }
    }
  };
  const done = loop();
  return {
    stop: () => {
      stopped = true;
      opened.close();
      void done.catch(() => undefined);
    },
  };
}

/** Run `body` while the harness-request follower drives a live Run (#117). The
 *  follower is started before `body` awaits settlement — an Agent Turn that pauses on
 *  an approval must be unblocked so the Run can rest — and stopped once it returns.
 *  `run launch` and `run resume` shared this identical try/finally. */
export async function withHarnessRequests<T>(
  port: ProjectionPort,
  runId: string,
  policy: HarnessRequestPolicy,
  body: () => Promise<T>,
): Promise<T> {
  const follower = followHarnessRequests(port, runId, policy);
  try {
    return await body();
  } finally {
    follower.stop();
  }
}
