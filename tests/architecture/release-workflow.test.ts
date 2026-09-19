import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CI_WORKFLOW,
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
