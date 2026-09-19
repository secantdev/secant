// The deterministic release-workflow policy check (spec #137, "Release workflow and
// legal gate"): it proves, over the parsed CI workflow, the properties acceptance
// #157 names for the candidate-validation path — job dependencies, immutable
// candidate reuse, credential placement, and validation-mode non-publication. It is
// pure over the parsed YAML object, so the real workflow and synthetic violations
// both exercise it (each guard is proven by a workflow that breaks exactly that
// guard). The test parses the file with `Bun.YAML`; this checker never touches the
// runtime.
//
// The validation path is not a second workflow: it is the manual-dispatch mode of
// the one CI gate (check.yml), which assembles the candidate once and adds the
// authenticated npm dry-run in the build job under `if: workflow_dispatch`. So the
// guards run over that one workflow — and, since #158, so does the tag-triggered
// promotion. `checkValidationWorkflow` owns the non-publishing validation; the
// `release-protection-policy` scenario (`checkReleaseProtection`, #158) owns the
// tag-admission and protected-`release`-environment boundary that rides in the same
// workflow. The two are complementary: validation forbids an `environment` on every
// job EXCEPT the one protected promotion job, and the protection scenario requires it
// there. Publication of the bytes themselves — a real publish step and its
// publication credential — is owned by `checkReleasePromotion` (#159).

export interface WorkflowIssue {
  file: string;
  message: string;
}

export const CI_WORKFLOW = ".github/workflows/check.yml";

// The candidate is assembled ONCE on the build job; only it may run these. Any other
// job running one would rebuild downstream instead of reusing the immutable artifact.
const BUILD_JOB = "build";
// The tag-admission and protected-promotion jobs (#158). The `release-approval` job
// gathers the candidate evidence and runs the tag/version gate; the `promote` job
// carries the protected `release` environment and is the human approval boundary.
const APPROVAL_JOB = "release-approval";
const PROMOTE_JOB = "promote";
const RELEASE_ENVIRONMENT = "release";
// The tag/version gate the approval job runs, and the ref form that gates both jobs to
// a `v*` tag so promotion never runs on a branch or a non-`v` tag. The `v` prefix is
// part of the invariant, so the guard requires it — not just any `refs/tags/`.
const TAG_GATE_SCRIPT = "scripts/release-gate.ts";
const TAG_REF_GUARD = /refs\/tags\/v/;
const ASSEMBLY_SCRIPTS = [
  "scripts/build.ts",
  "scripts/assemble.ts",
  "scripts/pack.ts",
  "scripts/pack-launcher.ts",
];
// The authenticated dry-run the validation path adds, and where it must live.
const DRY_RUN_SCRIPT = "scripts/npm-dry-run.ts";
const PROMOTION_SCRIPT = "scripts/release-promote.ts";
const PUBLISH_SECRET = "NPM_PUBLISH_TOKEN";

// The read-only npm identity is the ONLY pre-approval secret the workflow may name,
// and only on the dispatch-gated dry-run step in the build job. The publication
// credential is confined separately to protected promotion by checkReleasePromotion.
// Its secret name must read as read-only so a publish-capable token cannot be
// dropped in under the same reference.
const READONLY_SECRET = /READ_?ONLY/i;
const DISPATCH_GUARD = "workflow_dispatch";
// The step condition that POSITIVELY gates on a manual dispatch. A substring test
// would also pass a negated guard (`github.event_name != 'workflow_dispatch'`), which
// runs on every push/PR and skips only on dispatch — the exact opposite — so match
// the equality form explicitly.
const DISPATCH_GATE = /github\.event_name\s*==\s*['"]workflow_dispatch['"]/;

// Publication surfaces that must not appear anywhere in a non-publishing workflow:
// a real `npm publish` (no `--dry-run`), a GitHub-release action or `gh release`, or
// a retry wrapper (a flaky release step is fixed, never re-run to green).
const RELEASE_ACTIONS =
  /(?:softprops\/action-gh-release|actions\/create-release|ncipollo\/release-action)/;
const RETRY_ACTIONS = /nick-fields\/retry|wandalen\/wretry/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The trigger names of an `on:` node, which YAML may render as a string, a list, or
 *  a mapping. An unrecognised shape yields no triggers, so the dispatch guard fails
 *  closed. */
function triggerNames(on: unknown): Set<string> {
  if (typeof on === "string") return new Set([on]);
  if (Array.isArray(on)) {
    return new Set(
      on.filter((entry): entry is string => typeof entry === "string"),
    );
  }
  if (isRecord(on)) return new Set(Object.keys(on));
  return new Set();
}

/** The steps of a job as records (non-mapping entries dropped). */
function stepsOf(job: Record<string, unknown>): Record<string, unknown>[] {
  const steps = job.steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter(isRecord);
}

/** Every `run:` script body in a job, flattened to one searchable string. */
function runScripts(job: Record<string, unknown>): string {
  return stepsOf(job)
    .map((step) => (typeof step.run === "string" ? step.run : ""))
    .join("\n");
}

/** Every `uses:` action reference in a job. */
function usesActions(job: Record<string, unknown>): string[] {
  return stepsOf(job).flatMap((step) =>
    typeof step.uses === "string" ? [step.uses] : [],
  );
}

/** Every `secrets.<NAME>` reference anywhere in a serialisable value. */
function secretsIn(value: unknown): string[] {
  if (value === undefined) return [];
  return [...JSON.stringify(value).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(
    (match) => match[1]!,
  );
}

/** The `needs` of a job, normalised to a set (YAML allows a scalar or a list). */
function needsOf(job: Record<string, unknown>): Set<string> {
  const needs = job.needs;
  if (typeof needs === "string") return new Set([needs]);
  if (Array.isArray(needs)) {
    return new Set(
      needs.filter((entry): entry is string => typeof entry === "string"),
    );
  }
  return new Set();
}

export function checkValidationWorkflow(workflow: unknown): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const add = (message: string) => issues.push({ file: CI_WORKFLOW, message });

  if (!isRecord(workflow)) {
    add("CI workflow is not a mapping");
    return issues;
  }

  // A workflow-level env applies to every job on every run, so it can never be
  // dispatch-gated — no secret may live there.
  for (const secret of secretsIn(workflow.env)) {
    add(
      `Workflow-level env references secret ${secret}; a credential must be scoped to a dispatch-gated step, never the whole workflow`,
    );
  }

  // 1. The validation entrypoint exists: the gate is manually dispatchable, so the
  //    dry-run runs on one commit on demand rather than off an earlier branch run.
  if (!triggerNames(workflow.on).has(DISPATCH_GUARD)) {
    add(
      `The validation path needs a manual entrypoint (\`on: ${DISPATCH_GUARD}\`)`,
    );
  }

  const jobs = workflow.jobs;
  if (!isRecord(jobs)) {
    add("CI workflow declares no jobs");
    return issues;
  }
  const buildJob = jobs[BUILD_JOB];
  if (!isRecord(buildJob)) {
    add(`CI workflow has no ${BUILD_JOB} job to assemble the one candidate`);
    return issues;
  }

  // The authenticated dry-run must live on the build job, on its just-packed bytes.
  if (!runScripts(buildJob).includes(DRY_RUN_SCRIPT)) {
    add(
      `The ${BUILD_JOB} job must run ${DRY_RUN_SCRIPT} for the candidate-validation dry-run`,
    );
  }

  for (const [name, jobValue] of Object.entries(jobs)) {
    if (!isRecord(jobValue)) {
      add(`Job ${name} is not a mapping`);
      continue;
    }
    const job = jobValue;
    const runs = runScripts(job);

    // 2. Job dependencies + immutable reuse. Every job but the canonical `check`
    //    gate and the `build` job that assembles the candidate must depend on
    //    `build` and consume its artifact — download it, never re-assemble. The
    //    protected `promote` job is exempt: it is the human approval gate, not an
    //    artifact consumer, and it depends on the `release-approval` job (which does
    //    download the candidate) rather than on `build` directly. Its full
    //    dependency closure is proven by `checkReleaseProtection`.
    if (name !== "check" && name !== BUILD_JOB && name !== PROMOTE_JOB) {
      if (!needsOf(job).has(BUILD_JOB)) {
        add(
          `Job ${name} must \`needs: ${BUILD_JOB}\` to consume the one candidate`,
        );
      }
      if (
        !usesActions(job).some((a) => a.startsWith("actions/download-artifact"))
      ) {
        add(`Job ${name} must download the candidate artifact, not rebuild it`);
      }
    }
    if (name !== BUILD_JOB) {
      for (const script of ASSEMBLY_SCRIPTS) {
        if (runs.includes(script)) {
          add(
            `Job ${name} re-runs ${script}; the candidate is assembled once on ${BUILD_JOB}`,
          );
        }
      }
    }

    // 3. Credential placement. A secret may appear only inside a step's env, on a
    //    step positively gated on a manual dispatch, in the build job, and only as a
    //    read-only npm identity — never at job level (which applies to every step on
    //    every run and cannot be gated), never a publication credential.
    for (const secret of secretsIn(job.env)) {
      add(
        `Job ${name} env references secret ${secret}; a credential must be scoped to a dispatch-gated step, not the whole job`,
      );
    }
    for (const step of stepsOf(job)) {
      const secrets = secretsIn(step);
      if (secrets.length === 0) continue;
      if (name !== BUILD_JOB && name !== PROMOTE_JOB) {
        add(
          `Job ${name} references a secret; only the ${BUILD_JOB} dry-run step may hold the read-only npm identity`,
        );
      }
      if (name === PROMOTE_JOB) continue;
      const guard = typeof step.if === "string" ? step.if : "";
      if (!DISPATCH_GATE.test(guard)) {
        add(
          `The credentialed step in ${name} must be gated on \`${DISPATCH_GUARD}\` (\`==\`), not exposed on every run`,
        );
      }
      for (const secret of secrets) {
        if (!READONLY_SECRET.test(secret)) {
          add(
            `Secret ${secret} must be a read-only identity (name must read read-only), not a publication credential`,
          );
        }
      }
    }

    // 4. Non-publication. Only the protected `promote` job (#158) may carry an
    //    environment; any other job declaring one would be a second protected/publish
    //    surface. No real publish, no GitHub release, no retry wrapper — nothing that
    //    could publish or hide a flake. (`promote` HAVING `environment: release` is
    //    required by `checkReleaseProtection`.)
    if ("environment" in job && name !== PROMOTE_JOB) {
      add(
        `Job ${name} declares an environment; only the protected ${PROMOTE_JOB} job may (#158), and publication of bytes is #159`,
      );
    }
    if (
      name !== PROMOTE_JOB &&
      /npm\s+publish/.test(runs) &&
      !/--dry-run/.test(runs)
    ) {
      add(
        `Job ${name} runs a real \`npm publish\`; validation publishes only with --dry-run`,
      );
    }
    if (name !== PROMOTE_JOB && /gh\s+release\s+/.test(runs)) {
      add(
        `Job ${name} runs \`gh release\`; validation exposes no public release`,
      );
    }
    for (const action of usesActions(job)) {
      if (name !== PROMOTE_JOB && RELEASE_ACTIONS.test(action)) {
        add(
          `Job ${name} uses release action ${action}; validation exposes no public release`,
        );
      }
      if (RETRY_ACTIONS.test(action)) {
        add(
          `Job ${name} uses retry action ${action}; a flaky release step is fixed, not re-run`,
        );
      }
    }
  }

  return issues;
}

/** The environment name a job targets, whether written as a string or a mapping with
 *  a `name`, or undefined when the job declares none. */
function environmentName(job: Record<string, unknown>): string | undefined {
  const environment = job.environment;
  if (typeof environment === "string") return environment;
  if (isRecord(environment) && typeof environment.name === "string") {
    return environment.name;
  }
  return undefined;
}

/** The transitive `needs` closure of a job: every job that must complete before it,
 *  directly or through the chain. Missing referents are ignored (fail closed elsewhere). */
function transitiveNeeds(
  jobs: Record<string, unknown>,
  start: string,
): Set<string> {
  const closure = new Set<string>();
  const queue = [
    ...needsOf(
      isRecord(jobs[start]) ? (jobs[start] as Record<string, unknown>) : {},
    ),
  ];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (closure.has(name)) continue;
    closure.add(name);
    const job = jobs[name];
    if (isRecord(job)) queue.push(...needsOf(job));
  }
  return closure;
}

/** The `release-protection-policy` scenario (#158, spec #137 "Release artifact set and
 *  publication workflow"): over the same parsed workflow, prove the tag-admission and
 *  protected-`release`-environment boundary — tag matching, dependency edges,
 *  environment placement, and credential boundaries. Pure over the parsed YAML, so the
 *  real workflow and synthetic violations both exercise it. */
export function checkReleaseProtection(workflow: unknown): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const add = (message: string) => issues.push({ file: CI_WORKFLOW, message });

  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    add("CI workflow has no jobs to check for release protection");
    return issues;
  }
  const jobs = workflow.jobs;

  const promote = jobs[PROMOTE_JOB];
  if (!isRecord(promote)) {
    add(
      `CI workflow has no ${PROMOTE_JOB} job to gate publication behind the protected ${RELEASE_ENVIRONMENT} environment`,
    );
    return issues;
  }
  const approval = jobs[APPROVAL_JOB];
  if (!isRecord(approval)) {
    add(
      `CI workflow has no ${APPROVAL_JOB} job to run the tag/version gate and write the approval summary`,
    );
    return issues;
  }

  // Environment placement: the promote job targets the protected `release`
  // environment, so a human approval stands between the candidate and any later
  // publication.
  if (environmentName(promote) !== RELEASE_ENVIRONMENT) {
    add(
      `Job ${PROMOTE_JOB} must target the protected \`environment: ${RELEASE_ENVIRONMENT}\``,
    );
  }

  // Dependency edges: the promote job's transitive needs must include every other
  // job, so the protected environment is unreachable until every candidate check is
  // green. (checkValidationWorkflow forbids any OTHER job carrying an environment.)
  const closure = transitiveNeeds(jobs, PROMOTE_JOB);
  for (const name of Object.keys(jobs)) {
    if (name === PROMOTE_JOB) continue;
    if (!closure.has(name)) {
      add(
        `Job ${PROMOTE_JOB} must (transitively) \`needs\` every candidate check; ${name} does not gate it`,
      );
    }
  }

  // Tag matching: both jobs are gated to a `v*` tag ref so promotion never runs on a
  // branch, and the approval job runs the tag/version gate that admits a tag only
  // when it exactly matches the package version.
  for (const [name, job] of [
    [APPROVAL_JOB, approval] as const,
    [PROMOTE_JOB, promote] as const,
  ]) {
    const guard = typeof job.if === "string" ? job.if : "";
    if (!TAG_REF_GUARD.test(guard)) {
      add(
        `Job ${name} must be gated on a \`${TAG_REF_GUARD.source}\` tag ref so promotion never runs on a branch`,
      );
    }
  }
  if (!runScripts(approval).includes(TAG_GATE_SCRIPT)) {
    add(
      `Job ${APPROVAL_JOB} must run ${TAG_GATE_SCRIPT} to admit a tag only when it matches the package version`,
    );
  }

  // Credential boundary: the approval job is before the protected environment and
  // must remain credential-free. The protected promote job's publication credential
  // is required and confined by checkReleasePromotion (#159).
  const approvalSecrets = secretsIn(approval);
  if (approvalSecrets.length > 0) {
    add(
      `Job ${APPROVAL_JOB} references a secret (${approvalSecrets.join(", ")}); no publication credential may exist before the protected boundary`,
    );
  }

  return issues;
}

function downloadedArtifactNames(job: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const step of stepsOf(job)) {
    if (
      typeof step.uses !== "string" ||
      !step.uses.startsWith("actions/download-artifact") ||
      !isRecord(step.with) ||
      typeof step.with.name !== "string"
    ) {
      continue;
    }
    names.add(step.with.name);
  }
  return names;
}

/** The `release-promotion-state-machine` scenario (#159, spec #137 "Release
 * artifact set and publication workflow"): the protected job alone receives the
 * publication identity, downloads both immutable candidate artifacts, and invokes
 * the one state machine that verifies and publishes npm-first/GitHub-last. The
 * script's deterministic suite proves fresh, partial, identical-rerun, and conflict
 * behavior on every canonical test OS; this check proves its CI placement. */
export function checkReleasePromotion(workflow: unknown): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const add = (message: string) => issues.push({ file: CI_WORKFLOW, message });

  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    add("CI workflow has no jobs to check for release promotion");
    return issues;
  }
  const jobs = workflow.jobs;
  const promote = jobs[PROMOTE_JOB];
  if (!isRecord(promote)) {
    add(`CI workflow has no ${PROMOTE_JOB} job for release promotion`);
    return issues;
  }

  if (environmentName(promote) !== RELEASE_ENVIRONMENT) {
    add(
      `Job ${PROMOTE_JOB} must target the protected \`environment: ${RELEASE_ENVIRONMENT}\` before publication`,
    );
  }
  const runs = runScripts(promote);
  if (!runs.includes(PROMOTION_SCRIPT)) {
    add(
      `Job ${PROMOTE_JOB} must run ${PROMOTION_SCRIPT} as the one publication state machine`,
    );
  }
  const artifacts = downloadedArtifactNames(promote);
  for (const name of ["release-archives", "platform-packages"]) {
    if (!artifacts.has(name)) {
      add(
        `Job ${PROMOTE_JOB} must download the approved ${name} artifact without rebuilding it`,
      );
    }
  }
  const permissions = isRecord(promote.permissions)
    ? promote.permissions
    : undefined;
  if (permissions?.contents !== "write") {
    add(
      `Job ${PROMOTE_JOB} needs \`permissions: contents: write\` to expose approved GitHub release assets`,
    );
  }

  let promotionCredentialCount = 0;
  for (const [name, jobValue] of Object.entries(jobs)) {
    if (!isRecord(jobValue)) continue;
    for (const step of stepsOf(jobValue)) {
      const secrets = secretsIn(step);
      for (const secret of secrets) {
        if (name === PROMOTE_JOB && secret !== PUBLISH_SECRET) {
          add(
            `Job ${PROMOTE_JOB} references unexpected secret ${secret}; only ${PUBLISH_SECRET} belongs on the protected state-machine step`,
          );
          continue;
        }
        if (secret !== PUBLISH_SECRET) continue;
        if (
          name === PROMOTE_JOB &&
          typeof step.run === "string" &&
          step.run.includes(PROMOTION_SCRIPT)
        ) {
          promotionCredentialCount += 1;
        } else {
          add(
            `Publication credential ${PUBLISH_SECRET} may appear only on the protected promote job's state-machine step`,
          );
        }
      }
    }
  }
  if (promotionCredentialCount !== 1) {
    add(
      `The protected promote state-machine step must reference exactly one ${PUBLISH_SECRET} environment secret`,
    );
  }

  for (const [name, jobValue] of Object.entries(jobs)) {
    if (name === PROMOTE_JOB || !isRecord(jobValue)) continue;
    if (runScripts(jobValue).includes(PROMOTION_SCRIPT)) {
      add(
        `${PROMOTION_SCRIPT} may run only in the protected promote job, never a developer-facing validation job`,
      );
    }
  }

  return issues;
}
