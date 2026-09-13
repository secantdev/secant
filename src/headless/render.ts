import type {
  BundleTrustState,
  EngineRange,
  ExecutionSummary,
  InstalledBundleFocus,
  InstalledBundleSummary,
  RoutingNodeView,
  RunView,
} from "../application/projection-port.js";

// The headless client's plain-text renderers: pure snapshot → string functions
// with no IO, kept in this private submodule so the entry holds argv dispatch
// only (OpenCode likewise keeps handlers and views in sibling files). The entry
// re-imports `renderRow` and `renderFocus`; the rest are their private helpers.
// Status is carried by words so the output reads without colour.

export function renderRow(bundle: InstalledBundleSummary): string {
  const lines = [
    `${bundle.id}@${bundle.version} [${bundle.stability}]`,
    `  name: ${bundle.name}`,
    `  digest: sha256:${bundle.digest}`,
    `  origin: ${bundle.origin.kind} ${bundle.origin.location}`,
    `  platforms: ${bundle.platforms.join(", ")}`,
    `  engine: ${renderEngine(bundle.engine)}`,
    `  trust: ${renderTrust(bundle.trust)}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function renderFocus(bundle: InstalledBundleFocus): string {
  const lines: string[] = [
    `${bundle.id}@${bundle.version} [${bundle.stability}]`,
    `Name: ${bundle.name}`,
    `Description: ${bundle.description}`,
    `Digest: sha256:${bundle.digest}`,
    `Origin: ${bundle.origin.kind} ${bundle.origin.location}`,
    `Platforms: ${bundle.platforms.join(", ")}`,
    `Engine: ${renderEngine(bundle.engine)}`,
    `Trust: ${renderTrust(bundle.trust)}`,
  ];
  const author = bundle.author;
  if (author.authors) lines.push(`Authors: ${author.authors.join(", ")}`);
  if (author.license !== undefined) lines.push(`License: ${author.license}`);
  if (author.homepage !== undefined) lines.push(`Homepage: ${author.homepage}`);
  if (author.repository !== undefined)
    lines.push(`Repository: ${author.repository}`);
  if (author.keywords) lines.push(`Keywords: ${author.keywords.join(", ")}`);
  if (author.notices) lines.push(`Notices: ${author.notices.join(", ")}`);

  lines.push("", "Launch inputs:");
  if (bundle.launchInputs.length === 0) lines.push("  (none)");
  for (const input of bundle.launchInputs) {
    const choices = input.choices
      ? ` choices=[${input.choices.join(", ")}]`
      : "";
    const schema = input.schema !== undefined ? ` schema=${input.schema}` : "";
    lines.push(
      `  ${input.name} (${input.type})${schema}${choices}: ${input.description}`,
    );
  }

  lines.push("", "Routing:");
  for (const node of bundle.routing) lines.push(...renderRoutingNode(node));

  lines.push(
    "",
    `Workspace prerequisites: ${
      bundle.workspacePrerequisites.length === 0
        ? "(none)"
        : bundle.workspacePrerequisites.join(", ")
    }`,
  );

  lines.push("", "Produced artifacts:");
  if (bundle.producedArtifacts.length === 0) lines.push("  (none)");
  for (const produced of bundle.producedArtifacts) {
    const path = produced.path !== undefined ? ` path=${produced.path}` : "";
    lines.push(
      `  ${produced.name} (${produced.type}) home=${produced.home}${path} from ${produced.producedBy}`,
    );
  }

  lines.push("", ...renderExecutionSummary(bundle.executionSummary));

  lines.push("", "Composition findings:");
  if (bundle.compositionFindings.length === 0) {
    lines.push("  none (0 errors)");
  } else {
    for (const finding of bundle.compositionFindings) {
      lines.push(
        `  [${finding.severity}] ${finding.code} @ ${finding.target}: ${finding.explanation}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderRun(run: RunView): string {
  const lines: string[] = [
    `Run ${run.runId}`,
    `Bundle: ${run.bundle.id}@${run.bundle.version} (${run.bundle.name})`,
    `Digest: sha256:${run.bundle.digest}`,
    `Workspace: ${run.workspacePath}`,
    `Launched: ${run.launchedAt}`,
    `State: ${run.state}`,
    `Position: ${
      run.position >= run.progress.length
        ? "at rest"
        : `step ${run.position + 1} of ${run.progress.length}`
    }`,
  ];

  // A blocked Run rests at a Review checkpoint (#84): print the authored message,
  // the cadence, the completed-iteration count, the latest fail Verdict, and the
  // Gate's exact durable reference. Output references print under "Outputs:".
  const checkpoint = run.checkpoint;
  if (checkpoint !== undefined) {
    lines.push(
      "",
      "Review checkpoint:",
      `  message: ${checkpoint.message}`,
      `  cadence: every ${checkpoint.interval} iteration(s)`,
      `  completed iterations: ${checkpoint.completedIterations}`,
      `  latest verdict: ${checkpoint.latestVerdict.name} = ${checkpoint.latestVerdict.value}` +
        ` (ref ${checkpoint.latestVerdict.reference.runId}/${checkpoint.latestVerdict.reference.artifactName})`,
      `  gate: ${checkpoint.gate.shape} at step ${checkpoint.gate.stepId}` +
        ` (attempt ${checkpoint.gate.attemptId})`,
    );
  }

  lines.push("", "Progress:");
  if (run.progress.length === 0) lines.push("  (no steps)");
  for (const step of run.progress) {
    lines.push(`  ${step.id} (${step.kind}): ${step.status}`);
  }

  lines.push("", "Timeline:");
  if (run.timeline.length === 0) lines.push("  (none)");
  for (const event of run.timeline) {
    const detail = event.detail !== undefined ? ` ${event.detail}` : "";
    lines.push(`  ${event.at} ${event.event}${detail}`);
  }

  lines.push("", "Outputs:");
  if (run.outputs.length === 0) lines.push("  (none)");
  for (const output of run.outputs) {
    lines.push(
      `  ${output.name} (${output.type}) ref=${output.reference.runId}/${output.name}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderRoutingNode(node: RoutingNodeView): string[] {
  if (node.node === "step") {
    return [`  ${node.step.id} (${node.step.kind})`];
  }
  const lines = [
    `  repeat until ${node.until} (review every ${node.reviewCheckpoint.interval}: ${node.reviewCheckpoint.message})`,
  ];
  for (const step of node.steps) lines.push(`    ${step.id} (${step.kind})`);
  return lines;
}

function renderExecutionSummary(summary: ExecutionSummary): string[] {
  const counts = Object.entries(summary.stepKindCounts)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ");
  const lines = [
    `Execution summary (platform ${summary.platform}):`,
    `  step-kind counts: ${counts || "(none)"}`,
  ];
  if (summary.commands.length === 0) {
    lines.push("  commands: (none)");
  } else {
    lines.push("  commands:");
    for (const command of summary.commands) {
      const cwd =
        command.workingDirectory !== undefined
          ? ` cwd=${command.workingDirectory}`
          : "";
      const env =
        command.environmentVariableNames.length > 0
          ? ` env=[${command.environmentVariableNames.join(", ")}]`
          : "";
      const scripts =
        command.scripts.length > 0
          ? ` scripts=[${command.scripts.join(", ")}]`
          : "";
      lines.push(
        `    ${command.stepId}: ${command.executable}${cwd}${env}${scripts}`,
      );
    }
  }
  lines.push(`  warning: ${summary.warning}`);
  return lines;
}

function renderEngine(engine: EngineRange): string {
  return engine.satisfied ? engine.range : `${engine.range} (${engine.note})`;
}

function renderTrust(trust: BundleTrustState): string {
  switch (trust.state) {
    case "not-yet-trusted":
      return "not yet trusted";
    case "app-release":
      return "trusted (app release)";
    case "trusted":
      return `trusted (granted ${trust.grantedAt})`;
  }
}
