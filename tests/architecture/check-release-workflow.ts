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
// guards run over that one workflow. Scope: this ticket owns the non-publishing
// validation. The tag-triggered publication job, its protected `release`
// environment, and the partial-rerun rules are #158/#159 — which is why an
// `environment:` key or a publish step appearing here is a policy failure, not a
// feature.

export interface WorkflowIssue {
  file: string;
  message: string;
}

export const CI_WORKFLOW = ".github/workflows/check.yml";

// The candidate is assembled ONCE on the build job; only it may run these. Any other
// job running one would rebuild downstream instead of reusing the immutable artifact.
const BUILD_JOB = "build";
const ASSEMBLY_SCRIPTS = [
  "scripts/build.ts",
  "scripts/assemble.ts",
  "scripts/pack.ts",
  "scripts/pack-launcher.ts",
];
// The authenticated dry-run the validation path adds, and where it must live.
const DRY_RUN_SCRIPT = "scripts/npm-dry-run.ts";

// The read-only npm identity is the ONLY secret the workflow may name, and only on
// the dispatch-gated dry-run step in the build job (spec #137: no publication
// credential, and the read-only credential is exposed only when validation runs).
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
    //    `build` and consume its artifact — download it, never re-assemble.
    if (name !== "check" && name !== BUILD_JOB) {
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
      if (name !== BUILD_JOB) {
        add(
          `Job ${name} references a secret; only the ${BUILD_JOB} dry-run step may hold the read-only npm identity`,
        );
      }
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

    // 4. Non-publication. No protected environment, no real publish, no GitHub
    //    release, no retry wrapper — nothing that could publish or hide a flake.
    if ("environment" in job) {
      add(
        `Job ${name} declares an environment; the protected release environment is publication (#158/#159), out of scope here`,
      );
    }
    if (/npm\s+publish/.test(runs) && !/--dry-run/.test(runs)) {
      add(
        `Job ${name} runs a real \`npm publish\`; validation publishes only with --dry-run`,
      );
    }
    if (/gh\s+release\s+/.test(runs)) {
      add(
        `Job ${name} runs \`gh release\`; validation exposes no public release`,
      );
    }
    for (const action of usesActions(job)) {
      if (RELEASE_ACTIONS.test(action)) {
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
