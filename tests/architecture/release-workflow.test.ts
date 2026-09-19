import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CANDIDATE_CHECK_JOBS } from "../../scripts/release-gate.js";
import {
  CI_WORKFLOW,
  checkReleasePromotion,
  checkReleaseProtection,
  checkValidationWorkflow,
} from "./check-release-workflow.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Bun's YAML parser (Bun 1.4.2, YAML 1.2 — `on:` stays a string key, not a
 *  boolean), so the check needs no YAML dependency in the tree. */
function parseYaml(text: string): unknown {
  return (
    Bun as unknown as { YAML: { parse(text: string): unknown } }
  ).YAML.parse(text);
}

test("the real CI workflow satisfies the candidate-validation policy", () => {
  const text = readFileSync(join(repoRoot, CI_WORKFLOW), "utf8");
  assert.deepEqual(checkValidationWorkflow(parseYaml(text)), []);
});

test("the real CI workflow satisfies the release-protection policy", () => {
  const text = readFileSync(join(repoRoot, CI_WORKFLOW), "utf8");
  assert.deepEqual(checkReleaseProtection(parseYaml(text)), []);
});

test("the real CI workflow satisfies the release-promotion state-machine policy", () => {
  const text = readFileSync(join(repoRoot, CI_WORKFLOW), "utf8");
  assert.deepEqual(checkReleasePromotion(parseYaml(text)), []);
});

test("the approval summary's blocking-jobs list matches release-approval's needs", () => {
  // The reviewer-facing CANDIDATE_CHECK_JOBS list and the workflow's actual gating
  // edges must not drift; checkReleaseProtection guards the needs graph, this guards
  // the display copy.
  const text = readFileSync(join(repoRoot, CI_WORKFLOW), "utf8");
  const jobs = (
    parseYaml(text) as { jobs: Record<string, { needs: string[] }> }
  ).jobs;
  assert.deepEqual(
    [...CANDIDATE_CHECK_JOBS].sort(),
    [...jobs["release-approval"]!.needs].sort(),
  );
});

// A minimal workflow that passes every guard. Each negative case below breaks
// exactly one guard, so a failure names the guard whose removal it proves.
function valid(): Record<string, unknown> {
  return {
    on: { push: null, pull_request: null, workflow_dispatch: null },
    jobs: {
      check: {
        "runs-on": "ubuntu-latest",
        steps: [{ run: "bun run check" }],
      },
      build: {
        "runs-on": "ubuntu-latest",
        steps: [
          { run: "bun run scripts/build.ts --all" },
          { run: "bun run scripts/assemble.ts" },
          { run: "bun run scripts/pack.ts" },
          { run: "bun run scripts/pack-launcher.ts" },
          { run: "bun run scripts/inventory.ts" },
          {
            name: "Dry-run",
            if: "github.event_name == 'workflow_dispatch'",
            env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}" },
            run: "bun scripts/npm-dry-run.ts dist/packages",
          },
        ],
      },
      smoke: {
        needs: "build",
        "runs-on": "ubuntu-latest",
        steps: [
          { uses: "actions/download-artifact@v4" },
          { run: "bun scripts/package-smoke.ts dist/secant-linux-x64" },
        ],
      },
      "release-approval": {
        needs: ["check", "build", "smoke"],
        if: "startsWith(github.ref, 'refs/tags/v')",
        "runs-on": "ubuntu-latest",
        steps: [
          { uses: "actions/download-artifact@v4" },
          { run: "bun scripts/release-gate.ts dist/release" },
        ],
      },
      promote: {
        needs: "release-approval",
        if: "startsWith(github.ref, 'refs/tags/v')",
        "runs-on": "ubuntu-latest",
        environment: "release",
        permissions: { contents: "write" },
        steps: [
          { uses: "actions/checkout@v4" },
          {
            uses: "actions/download-artifact@v4",
            with: { name: "release-archives", path: "dist/release" },
          },
          {
            uses: "actions/download-artifact@v4",
            with: { name: "platform-packages", path: "dist/packages" },
          },
          {
            env: {
              NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}",
              GH_TOKEN: "${{ github.token }}",
            },
            run: "bun scripts/release-promote.ts dist/release dist/packages",
          },
        ],
      },
    },
  };
}

test("the minimal valid workflow passes, so each negative isolates one guard", () => {
  assert.deepEqual(checkValidationWorkflow(valid()), []);
});

test("a non-mapping workflow fails closed", () => {
  assert.ok(checkValidationWorkflow("not a workflow").length > 0);
  assert.ok(checkValidationWorkflow(null).length > 0);
});

test("a workflow without a manual dispatch entrypoint is rejected", () => {
  const workflow = valid();
  workflow.on = { push: null, pull_request: null };
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("manual entrypoint"),
    ),
  );
});

test("a build job that never runs the dry-run is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs.build.steps = (jobs.build.steps as Record<string, unknown>[]).slice(
    0,
    5,
  );
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("npm-dry-run.ts"),
    ),
  );
});

test("a downstream job missing `needs: build` is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  delete jobs.smoke.needs;
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("needs: build"),
    ),
  );
});

test("a downstream job that does not download the artifact is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs.smoke.steps = [
    { run: "bun scripts/package-smoke.ts dist/secant-linux-x64" },
  ];
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("download the candidate artifact"),
    ),
  );
});

test("a non-build job that re-runs an assembly script is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs.smoke.steps = [
    { uses: "actions/download-artifact@v4" },
    { run: "bun run scripts/assemble.ts" },
  ];
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("assembled once"),
    ),
  );
});

test("a secret outside the build dry-run step is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs.smoke.steps = [
    { uses: "actions/download-artifact@v4" },
    {
      if: "github.event_name == 'workflow_dispatch'",
      env: { TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}" },
      run: "echo hi",
    },
  ];
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("only the build dry-run step"),
    ),
  );
});

test("a credentialed step not gated on workflow_dispatch is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  const step = (jobs.build.steps as Record<string, unknown>[])[5]!;
  delete step.if;
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("gated on `workflow_dispatch`"),
    ),
  );
});

test("a NEGATED dispatch guard on a credentialed step is rejected", () => {
  // The exact opposite gate — runs on every push/PR, skips only on dispatch — still
  // contains the substring "workflow_dispatch", so a substring test would pass it.
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  const step = (jobs.build.steps as Record<string, unknown>[])[5]!;
  step.if = "github.event_name != 'workflow_dispatch'";
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("gated on `workflow_dispatch`"),
    ),
  );
});

test("a job-level env secret is rejected", () => {
  // Placed on the whole job (sibling of steps), it cannot be dispatch-gated: an
  // ungated step then runs with the credential on every push.
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs.build.env = { NODE_AUTH_TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}" };
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes(
        "scoped to a dispatch-gated step, not the whole job",
      ),
    ),
  );
});

test("a workflow-level env secret is rejected", () => {
  const workflow = valid();
  workflow.env = { NODE_AUTH_TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}" };
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("never the whole workflow"),
    ),
  );
});

test("a publication-capable secret is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  const step = (jobs.build.steps as Record<string, unknown>[])[5]!;
  step.env = { NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}" };
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("read-only identity"),
    ),
  );
});

test("a protected environment is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs.build.environment = "release";
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("environment"),
    ),
  );
});

test("a real npm publish is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  (jobs.smoke.steps as Record<string, unknown>[]).push({
    run: "npm publish dist/packages/secant.tgz",
  });
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("real `npm publish`"),
    ),
  );
});

test("a GitHub-release action or `gh release` is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs.smoke.steps = [
    { uses: "actions/download-artifact@v4" },
    { uses: "softprops/action-gh-release@v2" },
  ];
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("no public release"),
    ),
  );

  const withGhRelease = valid();
  const jobs2 = withGhRelease.jobs as Record<string, Record<string, unknown>>;
  (jobs2.smoke.steps as Record<string, unknown>[]).push({
    run: "gh release create v1.0.0",
  });
  assert.ok(
    checkValidationWorkflow(withGhRelease).some((issue) =>
      issue.message.includes("no public release"),
    ),
  );
});

test("a retry action is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs.smoke.steps = [
    { uses: "actions/download-artifact@v4" },
    { uses: "nick-fields/retry@v3" },
  ];
  assert.ok(
    checkValidationWorkflow(workflow).some((issue) =>
      issue.message.includes("re-run"),
    ),
  );
});

// --- release-protection-policy scenario (#158) -----------------------------------
// The same valid() workflow passes protection too, so each negative below isolates one
// protection guard.

test("the minimal valid workflow passes release protection", () => {
  assert.deepEqual(checkReleaseProtection(valid()), []);
});

test("release protection fails closed on a non-mapping workflow", () => {
  assert.ok(checkReleaseProtection("nope").length > 0);
  assert.ok(checkReleaseProtection(null).length > 0);
});

test("a workflow without a promote job is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  delete jobs.promote;
  assert.ok(
    checkReleaseProtection(workflow).some((issue) =>
      issue.message.includes("no promote job"),
    ),
  );
});

test("a promote job without the protected release environment is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  delete jobs.promote.environment;
  assert.ok(
    checkReleaseProtection(workflow).some((issue) =>
      issue.message.includes("environment: release"),
    ),
  );
});

test("a promote job targeting the wrong environment is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs.promote.environment = "staging";
  assert.ok(
    checkReleaseProtection(workflow).some((issue) =>
      issue.message.includes("environment: release"),
    ),
  );
});

test("a candidate check that does not gate promotion is rejected", () => {
  // smoke drops out of the dependency chain, so the protected environment could be
  // reached without it.
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs["release-approval"].needs = ["check", "build"];
  assert.ok(
    checkReleaseProtection(workflow).some((issue) =>
      issue.message.includes("smoke does not gate it"),
    ),
  );
});

test("a promote job not gated on a tag ref is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  delete jobs.promote.if;
  assert.ok(
    checkReleaseProtection(workflow).some((issue) =>
      issue.message.includes("tag ref"),
    ),
  );
});

test("a job gated on a non-`v` tag ref is rejected", () => {
  // `refs/tags/` alone is not enough: the `v*` shape is part of the invariant.
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs.promote.if = "startsWith(github.ref, 'refs/tags/')";
  assert.ok(
    checkReleaseProtection(workflow).some((issue) =>
      issue.message.includes("tag ref"),
    ),
  );
});

test("an approval job that never runs the tag/version gate is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs["release-approval"].steps = [{ uses: "actions/download-artifact@v4" }];
  assert.ok(
    checkReleaseProtection(workflow).some((issue) =>
      issue.message.includes("release-gate.ts"),
    ),
  );
});

test("a publication credential on a pre-approval promotion job is rejected", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  (jobs["release-approval"].steps as Record<string, unknown>[]).push({
    env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}" },
    run: "echo x",
  });
  assert.ok(
    checkReleaseProtection(workflow).some((issue) =>
      issue.message.includes("no publication credential"),
    ),
  );
});

// --- release-promotion-state-machine scenario (#159) -----------------------------

test("the minimal valid workflow passes release promotion", () => {
  assert.deepEqual(checkReleasePromotion(valid()), []);
});

test("release promotion fails closed on a non-mapping workflow", () => {
  assert.ok(checkReleasePromotion("nope").length > 0);
  assert.ok(checkReleasePromotion(null).length > 0);
});

test("release promotion requires the protected promote job and environment", () => {
  const missing = valid();
  const missingJobs = missing.jobs as Record<string, Record<string, unknown>>;
  delete missingJobs.promote;
  assert.ok(
    checkReleasePromotion(missing).some((issue) =>
      issue.message.includes("no promote job"),
    ),
  );

  const wrongEnvironment = valid();
  const wrongJobs = wrongEnvironment.jobs as Record<
    string,
    Record<string, unknown>
  >;
  wrongJobs.promote.environment = "staging";
  assert.ok(
    checkReleasePromotion(wrongEnvironment).some((issue) =>
      issue.message.includes("environment: release"),
    ),
  );
});

test("promotion must run the one release state-machine script", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  const steps = jobs.promote.steps as Record<string, unknown>[];
  steps[3]!.run = "echo approved";
  assert.ok(
    checkReleasePromotion(workflow).some((issue) =>
      issue.message.includes("release-promote.ts"),
    ),
  );
});

test("promotion must download both approved candidate artifacts", () => {
  for (const missing of ["release-archives", "platform-packages"]) {
    const workflow = valid();
    const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
    jobs.promote.steps = (
      jobs.promote.steps as Record<string, unknown>[]
    ).filter(
      (step) =>
        (step.with as Record<string, unknown> | undefined)?.name !== missing,
    );
    assert.ok(
      checkReleasePromotion(workflow).some((issue) =>
        issue.message.includes(missing),
      ),
    );
  }
});

test("the publication credential must exist only on the protected promote step", () => {
  const missingCredential = valid();
  const missingJobs = missingCredential.jobs as Record<
    string,
    Record<string, unknown>
  >;
  const promotionStep = (
    missingJobs.promote.steps as Record<string, unknown>[]
  )[3]!;
  promotionStep.env = { GH_TOKEN: "${{ github.token }}" };
  assert.ok(
    checkReleasePromotion(missingCredential).some((issue) =>
      issue.message.includes("NPM_PUBLISH_TOKEN"),
    ),
  );

  const duplicateCredential = valid();
  const duplicateJobs = duplicateCredential.jobs as Record<
    string,
    Record<string, unknown>
  >;
  (duplicateJobs.promote.steps as Record<string, unknown>[]).push({
    env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}" },
    run: "bun scripts/release-promote.ts duplicate",
  });
  assert.ok(
    checkReleasePromotion(duplicateCredential).some((issue) =>
      issue.message.includes("exactly one NPM_PUBLISH_TOKEN"),
    ),
  );

  const earlyCredential = valid();
  const earlyJobs = earlyCredential.jobs as Record<
    string,
    Record<string, unknown>
  >;
  (earlyJobs.smoke.steps as Record<string, unknown>[]).push({
    env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}" },
    run: "echo leaked",
  });
  assert.ok(
    checkReleasePromotion(earlyCredential).some((issue) =>
      issue.message.includes("only on the protected promote job"),
    ),
  );

  const extraCredential = valid();
  const extraJobs = extraCredential.jobs as Record<
    string,
    Record<string, unknown>
  >;
  const extraStep = (extraJobs.promote.steps as Record<string, unknown>[])[3]!;
  extraStep.env = {
    ...(extraStep.env as Record<string, unknown>),
    EXTRA_TOKEN: "${{ secrets.EXTRA_TOKEN }}",
  };
  assert.ok(
    checkReleasePromotion(extraCredential).some((issue) =>
      issue.message.includes("unexpected secret EXTRA_TOKEN"),
    ),
  );
});

test("the promotion state machine cannot run outside protected promote", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  (jobs.smoke.steps as Record<string, unknown>[]).push({
    run: "bun scripts/release-promote.ts dist/release dist/packages",
  });
  assert.ok(
    checkReleasePromotion(workflow).some((issue) =>
      issue.message.includes("only in the protected promote job"),
    ),
  );
});

test("promotion needs GitHub contents write permission for release assets", () => {
  const workflow = valid();
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  jobs.promote.permissions = { contents: "read" };
  assert.ok(
    checkReleasePromotion(workflow).some((issue) =>
      issue.message.includes("contents: write"),
    ),
  );
});
