import type {
  BundleTrustState,
  EngineRange,
  ExecutionSummary,
  HarnessDiscoveryView,
  HarnessFocus,
  HarnessQualificationView,
  HarnessSummary,
  InstalledBundleFocus,
  InstalledBundleSummary,
  RoutingNodeView,
  RunListGroup,
  RunListSnapshot,
  RunView,
  SendInteractiveTurnOffer,
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

export function renderHarnessRow(harness: HarnessSummary): string {
  const lines = [
    `${harness.name} (${harness.id})`,
    `  Discovery: ${renderHarnessDiscovery(harness.discovery)}`,
    `  Qualification: ${renderQualification(harness.qualification)}`,
  ];
  if (
    harness.qualification.state === "qualified" ||
    harness.qualification.state === "qualified-with-limits"
  ) {
    lines.push(...renderHarnessObservation(harness.qualification, "  "));
  }
  return `${lines.join("\n")}\n`;
}

export function renderHarnessFocus(harness: HarnessFocus): string {
  const lines = [
    `${harness.name} (${harness.id})`,
    `Discovery: ${renderHarnessDiscovery(harness.discovery)}`,
    `Qualification: ${renderQualification(harness.qualification)}`,
  ];
  if (
    harness.qualification.state === "qualified" ||
    harness.qualification.state === "qualified-with-limits"
  ) {
    lines.push(...renderHarnessObservation(harness.qualification));
  } else if (harness.qualification.state === "not-ready") {
    lines.push(`Checked at: ${harness.qualification.checkedAt}`);
  }

  lines.push("");
  if (harness.supportedModels === undefined) {
    lines.push("Supported models: Not checked");
  } else if (harness.supportedModels.kind === "free-text") {
    lines.push("Supported models: Free-text model entry");
  } else {
    lines.push(
      `Supported models: ${harness.supportedModels.models.join(", ")}`,
    );
  }

  lines.push("", "Capabilities:");
  for (const capability of harness.capabilities) {
    const state = capability.state
      .split("-")
      .map((word) => word[0]?.toUpperCase() + word.slice(1))
      .join(" ");
    lines.push(`  ${capability.name}: ${state}`);
    lines.push(`    ${capability.description}`);
    if (capability.limits !== undefined) {
      lines.push(`    Limits: ${capability.limits}`);
    }
  }

  lines.push(
    "",
    `Configuration: ${harness.configurationPosture ?? "Not checked"}`,
  );
  if (harness.authenticationInstructions !== undefined) {
    lines.push(`Authentication: ${harness.authenticationInstructions}`);
  }
  if (harness.unavailable !== undefined) {
    lines.push(
      `Unavailable: ${harness.unavailable.explanation}`,
      `Remediation: ${harness.unavailable.remediation}`,
    );
  }
  if (harness.diagnosticReference !== undefined) {
    const reference = harness.diagnosticReference;
    lines.push(
      `Diagnostic: ${reference.type}:${reference.harnessId}:${reference.checkedAt}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderHarnessDiscovery(discovery: HarnessDiscoveryView): string {
  if (discovery.state === "found") {
    return `found via ${discovery.description}`;
  }
  if (discovery.state === "unsupported-shim") {
    return `unsupported shim ${discovery.path}`;
  }
  return `not found; searched ${discovery.searched.join(", ")}`;
}

function renderQualification(qualification: HarnessQualificationView): string {
  return qualification.state.replaceAll("-", " ");
}

function renderHarnessObservation(
  qualification: Extract<
    HarnessQualificationView,
    { state: "qualified" | "qualified-with-limits" }
  >,
  indentation = "",
): readonly string[] {
  const { observation } = qualification;
  return [
    `${indentation}Observed executable: ${observation.executable}`,
    `${indentation}Observed version: ${observation.executableVersion}`,
    `${indentation}Observed platform: ${observation.platform}`,
    `${indentation}Checked at: ${observation.checkedAt}`,
  ];
}

export function renderRun(run: RunView): string {
  const lines: string[] = [
    `Run ${run.runId}`,
    `Bundle: ${run.bundle.id}@${run.bundle.version} (${run.bundle.name})`,
    `Digest: sha256:${run.bundle.digest}`,
    `Workspace: ${run.workspacePath}`,
    `Launched: ${run.launchedAt}`,
    `State: ${run.state}`,
    // Whether the Run is live in this instance or another, naming the owner
    // process (ADR 0031). Omitted when the Run is not live: its `State` already
    // says so, and a rested Run has no owner to name.
    ...(run.liveness.state === "not-live"
      ? []
      : [
          `Live: ${
            run.liveness.state === "live-here"
              ? `in this instance (process ${run.liveness.ownerPid})`
              : `in another instance (process ${run.liveness.ownerPid})`
          }`,
        ]),
    `Position: ${
      run.position >= run.progress.length
        ? "at rest"
        : `step ${run.position + 1} of ${run.progress.length}`
    }`,
    ...(run.selectedHarness !== undefined
      ? [`Selected Harness: ${run.selectedHarness}`]
      : []),
    // The normalized Harness identity that qualified the current or latest Agent-step
    // Attempt (#125): name, resolved executable, and observed version. Omitted for a
    // Command-only Run; no value is invented when a fact is unavailable.
    ...(run.harness !== undefined
      ? [
          `Observed Harness: ${run.harness.name}`,
          `Observed executable: ${run.harness.executable}`,
          `Observed version: ${run.harness.executableVersion}`,
        ]
      : []),
    // The immutable model requested at launch (#187), beside the observed effective
    // model so the two stay distinct. Omitted when no model was requested.
    ...(run.requestedModel !== undefined
      ? [`Requested model: ${run.requestedModel}`]
      : []),
    // The effective model the latest Agent-step Attempt ran under (#116), from the
    // Harness init message. Omitted for a Command-only Run.
    ...(run.effectiveModel !== undefined
      ? [`Observed effective model: ${run.effectiveModel}`]
      : []),
    ...(run.turnPosition !== undefined ? [`Turns: ${run.turnPosition}`] : []),
  ];

  // A blocked Run rests at a Review checkpoint (#84): print the authored message,
  // the cadence, the completed-iteration count, the latest fail Verdict, and the
  // Gate's exact durable reference. Output references print under "Outputs:".
  const checkpoint = run.checkpoint;
  const answerOffer = run.actionOffers.find(
    (offer) => offer.action === "answer-human-gate",
  );
  if (checkpoint !== undefined) {
    lines.push(
      "",
      ...(answerOffer !== undefined ? [`Blocked: ${answerOffer.basis}`] : []),
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

  // A blocked Run resting at an authored Human Gate (#108): read the basis from
  // its Offer, then print the shape, exact rendered message, declared
  // free-text output, and the Gate's durable reference.
  const pendingGate = run.pendingGate;
  if (pendingGate !== undefined) {
    lines.push(
      "",
      ...(answerOffer !== undefined ? [`Blocked: ${answerOffer.basis}`] : []),
      "Human Gate:",
      `  shape: ${pendingGate.gate.shape}`,
      `  message: ${pendingGate.message}`,
      ...(pendingGate.outputArtifactName !== undefined
        ? [`  output: ${pendingGate.outputArtifactName}`]
        : []),
      ...(pendingGate.suggestions !== undefined
        ? [
            `  suggestions: ${pendingGate.suggestions.join(", ")} (or any other text)`,
          ]
        : []),
      `  gate: ${pendingGate.gate.shape} at step ${pendingGate.gate.stepId}` +
        ` (attempt ${pendingGate.gate.attemptId})`,
    );
  }

  // A blocked Run resting at an interactive-agent Step (#122) names its basis from the
  // send-interactive-turn Offer, present at a Turn boundary. Its transcript is reached by
  // reference, never inlined here (A15). The ephemeral Harness Request basis is the third
  // case; it rides the live overlay, so `run show` prints it, not this pure renderer.
  const interactiveOffer = run.actionOffers.find(
    (offer): offer is SendInteractiveTurnOffer =>
      offer.action === "send-interactive-turn",
  );
  if (interactiveOffer !== undefined) {
    lines.push("", `Blocked: ${interactiveOffer.basis}`);
  }

  // The answer-human-gate offer appears only while blocked (#85, #108); print each
  // answer's consequence so `run show` states what each answer does. A free-text
  // gate names `--text`; an approve/reject gate (or checkpoint) names `--continue`/`--stop`.
  for (const offer of run.actionOffers) {
    if (offer.action !== "answer-human-gate") continue;
    if (offer.gate.shape === "free-text") {
      lines.push(
        "",
        "Answer the gate:",
        `  secant run answer ${run.runId} --text <value>  # ${offer.textConsequence ?? "publish the answer as the gate's output"}`,
      );
    } else {
      lines.push(
        "",
        "Answer the checkpoint:",
        `  secant run answer ${run.runId} --continue  # ${offer.continueConsequence}`,
        `  secant run answer ${run.runId} --stop      # ${offer.stopConsequence}`,
      );
    }
  }

  // The resume-run offer appears only while resting halted or failed (#86); print
  // the command and what resume does, or — when the Port marks it unavailable
  // (#194 story 40) — the reason instead of a command, so the surface stays
  // truthful rather than offering a resume that cannot proceed.
  for (const offer of run.actionOffers) {
    if (offer.action !== "resume-run") continue;
    if (!offer.available) {
      lines.push("", "Resume:", `  unavailable — ${offer.reason}`);
    } else {
      lines.push(
        "",
        "Resume:",
        `  secant run resume ${run.runId}  # ${offer.consequence}`,
        // An indeterminate Command Attempt may repeat its effects on re-run (#194
        // story 39): state the risk the TUI arms an acknowledgement for.
        ...(offer.acknowledgement !== undefined
          ? [`  warning: ${offer.acknowledgement}`]
          : []),
      );
    }
  }

  // The cancel/delete offers appear only when legal (#87): cancel while live,
  // delete while at rest. Print the command and what it does.
  for (const offer of run.actionOffers) {
    if (offer.action === "cancel-run") {
      lines.push(
        "",
        "Actions:",
        `  secant run cancel ${run.runId}  # ${offer.consequence}`,
      );
    } else if (offer.action === "delete-run") {
      lines.push(
        "",
        "Actions:",
        `  secant run delete ${run.runId}  # ${offer.consequence}`,
      );
    }
  }

  lines.push("", "Progress:");
  if (run.progress.length === 0) lines.push("  (no steps)");
  for (const step of run.progress) {
    lines.push(`  ${step.id} (${step.kind}): ${step.status}`);
  }

  lines.push("", "Timeline:");
  if (run.timeline.length === 0) lines.push("  (none)");
  for (const event of run.timeline) {
    // The recorded Turn kind (#126) distinguishes a historical Agent Turn from an
    // Interactive Turn in the plain-text timeline, in the same order; a legacy row
    // with no kind prints without it. Additive to the frozen `--json`.
    const kind = event.turnKind !== undefined ? ` ${event.turnKind}` : "";
    const detail = event.detail !== undefined ? ` ${event.detail}` : "";
    lines.push(`  ${event.at} ${event.event}${kind}${detail}`);
  }

  if (run.conflict !== undefined) {
    lines.push(
      "",
      "Materialization conflict:",
      `  artifact: ${run.conflict.artifactName}`,
      `  path: ${run.conflict.path}`,
    );
  }

  // The named Harness Sessions this Run opened and their last availability (#116).
  if (run.sessions !== undefined && run.sessions.length > 0) {
    lines.push("", "Sessions:");
    for (const session of run.sessions) {
      lines.push(`  ${session.session}: ${session.availability}`);
    }
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

const GROUP_HEADINGS: Record<RunListGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  older: "Older",
};

export function renderRunList(snapshot: RunListSnapshot): string {
  const scope =
    snapshot.filter === "resumable" ? "Resumable Runs" : "Previous Runs";
  if (snapshot.empty) {
    return `${scope}: none yet.\n`;
  }
  // A page past the end of history (only reachable from a stale/hand-made cursor)
  // has no rows though the list is not empty; say so rather than a bare heading.
  if (snapshot.rows.length === 0) {
    return `${scope}: no more runs (beginning of history).\n`;
  }
  const lines: string[] = [`${scope}:`];
  // Rows are already newest-first and grouped; print each group heading once as it
  // first appears, so the order stays Today, then Yesterday, then Older.
  let current: RunListGroup | undefined;
  for (const row of snapshot.rows) {
    if (row.group !== current) {
      current = row.group;
      lines.push("", `${GROUP_HEADINGS[current]}:`);
    }
    lines.push(`  ${row.runId}  ${row.bundleName}  (${row.activityAt})`);
  }
  if (snapshot.nextCursor !== undefined) {
    lines.push(
      "",
      `More runs: secant run list --before ${snapshot.nextCursor}`,
    );
  } else if (snapshot.beginningOfHistory) {
    lines.push("", "(beginning of history)");
  }
  return `${lines.join("\n")}\n`;
}

function renderRoutingNode(node: RoutingNodeView): string[] {
  if (node.node === "step") {
    return [`  ${node.step.id} (${node.step.kind})`];
  }
  const lines = [
    "control" in node
      ? "  repeat until a human ends the stage (Continue opens each next iteration)"
      : `  repeat until ${node.until} (review every ${node.reviewCheckpoint.interval}: ${node.reviewCheckpoint.message})`,
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
