import type { Command } from "commander";
import type {
  HarnessFocusSnapshot,
  OpenedProjection,
  Problem,
  ProjectionPort,
} from "../application/projection-port.js";
import type { CommandExecutor, HeadlessIO, SettleAction } from "./headless.js";
import { renderHarnessFocus, renderHarnessRow } from "./render.js";

interface HarnessCommandDeps {
  readonly io: HeadlessIO;
  readonly execute: CommandExecutor;
  readonly settle: SettleAction;
  readonly fail: (io: HeadlessIO, json: boolean, problem: Problem) => number;
}

/** Register the read-only Harness catalog commands after Commander settings have
 * been configured on the root program. */
export function registerHarnessCommands(
  program: Command,
  deps: HarnessCommandDeps,
): void {
  const { io, execute, settle, fail } = deps;
  const harness = program
    .command("harness")
    .description("list and inspect registered Harnesses");

  harness
    .command("list")
    .description("list every registered Harness without qualifying it")
    .option("--json", "print the Projection snapshot as JSON")
    .action((options: { json?: boolean }) =>
      settle(
        execute((clients) =>
          listHarnesses(clients.projectionPort, io, options.json ?? false),
        ),
      ),
    );

  harness
    .command("inspect")
    .description("qualify and show one registered Harness")
    .argument("[id]", "semantic Harness id")
    .option("--json", "print the focused Harness as JSON")
    .action((id: string | undefined, options: { json?: boolean }) => {
      const json = options.json ?? false;
      if (id === undefined) {
        return settle(
          fail(io, json, {
            code: "missing-harness-id",
            explanation: "harness inspect needs a Harness id.",
            remediation: "Run `secant harness inspect <id>`.",
            possibleEffects: "none",
          }),
        );
      }
      return settle(
        execute((clients) =>
          inspectHarness(clients.projectionPort, io, fail, json, id),
        ),
      );
    });
}

function listHarnesses(
  port: ProjectionPort,
  io: HeadlessIO,
  json: boolean,
): number {
  const opened = port.openProjection({ family: "harness-catalog" });
  try {
    const snapshot = opened.snapshot;
    if (json) {
      io.out(`${JSON.stringify(snapshot, null, 2)}\n`);
      return 0;
    }
    if (snapshot.harnesses.length === 0) {
      io.out("No Harnesses are registered.\n");
      return 0;
    }
    io.out(snapshot.harnesses.map(renderHarnessRow).join("\n"));
    return 0;
  } finally {
    opened.close();
  }
}

async function inspectHarness(
  port: ProjectionPort,
  io: HeadlessIO,
  fail: HarnessCommandDeps["fail"],
  json: boolean,
  id: string,
): Promise<number> {
  const opened = port.openProjection({
    family: "harness-catalog",
    focus: { id },
  });
  try {
    const snapshot = await qualifiedSnapshot(opened);
    if (!snapshot.result.found) {
      return fail(io, json, snapshot.result.problem);
    }
    const harness = snapshot.result.harness;
    if (json) {
      io.out(`${JSON.stringify(harness, null, 2)}\n`);
      return 0;
    }
    io.out(renderHarnessFocus(harness));
    return 0;
  } finally {
    opened.close();
  }
}

async function qualifiedSnapshot(
  opened: OpenedProjection<HarnessFocusSnapshot>,
): Promise<HarnessFocusSnapshot> {
  const initial = opened.snapshot;
  if (
    !initial.result.found ||
    initial.result.harness.qualification.state !== "not-checked"
  ) {
    return initial;
  }

  for await (const update of opened.updates) {
    if (update.kind === "durable") return update.snapshot;
    if (update.kind === "closed") break;
  }
  return initial;
}
