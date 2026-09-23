import assert from "node:assert/strict";
import test from "node:test";
import {
  checkComposition,
  type AuthoredManifest,
  type RoutingNode,
  type TextAssets,
} from "../../src/workflow/workflow.js";

// A composing manifest: a launch input binds `doc`, a baseline command binds the
// `test-verdict` verdict before the repeat group, and the group repeats until it.
// Each negative case mutates exactly one thing and asserts the one finding it
// yields, so the suite pins one distinct stable code per composition rule.

function manifest(parts: Partial<AuthoredManifest> = {}): AuthoredManifest {
  return {
    formatVersion: 1,
    bundle: {
      id: "io.example.x",
      version: "1.0.0",
      name: "X",
      description: "x",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: { doc: { type: "file", description: "the doc" } },
    assets: [
      { path: "p.md", kind: "prompt" },
      { path: "s.json", kind: "schema" },
      { path: "run.sh", kind: "script" },
    ],
    routing: routing(),
    ...parts,
  };
}

function routing(
  overrides: { seed?: RoutingNode; group?: RoutingNode } = {},
): RoutingNode[] {
  return [
    overrides.seed ?? {
      id: "seed",
      kind: "command",
      requires: ["doc"],
      produces: [{ name: "v", type: "verdict" }],
      command: { executable: "bash", arguments: [{ asset: "run.sh" }] },
    },
    overrides.group ?? {
      repeat: {
        until: "v",
        reviewCheckpoint: { interval: 5, message: "continue?" },
        steps: [
          {
            id: "a",
            kind: "agent",
            session: "s",
            requires: ["doc"],
            prompt: { asset: "p.md" },
          },
          {
            id: "run",
            kind: "command",
            requires: ["doc"],
            produces: [{ name: "v", type: "verdict" }],
            command: { executable: "bash", arguments: [{ asset: "run.sh" }] },
          },
        ],
      },
    },
  ];
}

const okText = new Map<string, string | null>([
  ["p.md", "use {{artifact:doc}}"],
  ["s.json", '{"type":"object"}'],
]);

function run(m: AuthoredManifest, text: TextAssets = okText) {
  return checkComposition(m, text);
}

test("a fully-bound manifest composes with no findings", () => {
  assert.deepEqual(run(manifest()), []);
});

test("two `fresh` Agent Steps warn that they do not share a Session (A14)", () => {
  const twoFresh = manifest({
    routing: [
      {
        id: "a1",
        kind: "agent",
        session: "fresh",
        requires: ["doc"],
        prompt: { asset: "p.md" },
      },
      {
        id: "a2",
        kind: "agent",
        session: "fresh",
        requires: ["doc"],
        prompt: { asset: "p.md" },
      },
    ],
  });
  const findings = run(twoFresh);
  const fresh = findings.filter((f) => f.code === "fresh-session-not-shared");
  assert.equal(fresh.length, 2);
  assert.deepEqual(fresh.map((f) => f.target).sort(), ["a1", "a2"]);
  assert.ok(fresh.every((f) => f.severity === "warning"));

  // A single `fresh` Step is unambiguous and raises nothing.
  const oneFresh = manifest({
    routing: [
      {
        id: "a1",
        kind: "agent",
        session: "fresh",
        requires: ["doc"],
        prompt: { asset: "p.md" },
      },
    ],
  });
  assert.equal(
    run(oneFresh).some((f) => f.code === "fresh-session-not-shared"),
    false,
  );
});

const cases: ReadonlyArray<{
  readonly title: string;
  readonly manifest: AuthoredManifest;
  readonly text?: TextAssets;
  readonly code: string;
  readonly target: string;
}> = [
  {
    title: "an unbound required artifact",
    manifest: manifest({
      routing: routing({
        seed: {
          id: "seed",
          kind: "command",
          requires: ["missing"],
          produces: [{ name: "v", type: "verdict" }],
          command: { executable: "bash", arguments: [{ asset: "run.sh" }] },
        },
      }),
    }),
    code: "unbound-artifact",
    target: "seed",
  },
  {
    title: "a producer that rebinds a name to a different type",
    manifest: manifest({
      routing: routing({
        seed: {
          id: "seed",
          kind: "command",
          requires: ["doc"],
          produces: [
            { name: "v", type: "verdict" },
            { name: "doc", type: "verdict" },
          ],
          command: { executable: "bash", arguments: [{ asset: "run.sh" }] },
        },
      }),
    }),
    code: "artifact-type-mismatch",
    target: "seed",
  },
  {
    title: "a prompt slot naming an artifact the Step does not require",
    manifest: manifest(),
    text: new Map([...okText, ["p.md", "use {{artifact:ghost}}"]]),
    code: "unknown-prompt-slot",
    target: "a",
  },
  {
    title: "a malformed prompt slot",
    manifest: manifest(),
    text: new Map([...okText, ["p.md", "run {{loop}} forever"]]),
    code: "malformed-prompt-slot",
    target: "a",
  },
  {
    title: "a Repeat verdict not bound before entry",
    manifest: manifest({
      routing: routing({
        seed: {
          id: "seed",
          kind: "command",
          requires: ["doc"],
          command: { executable: "bash", arguments: [{ asset: "run.sh" }] },
        },
      }),
    }),
    code: "verdict-unbound-before-entry",
    target: "routing[1].repeat.until",
  },
  {
    title: "an out-of-range reviewCheckpoint interval",
    manifest: manifest({
      routing: routing({
        group: {
          repeat: {
            until: "v",
            reviewCheckpoint: { interval: 1000, message: "continue?" },
            steps: [
              {
                id: "a",
                kind: "agent",
                session: "s",
                requires: ["doc"],
                prompt: { asset: "p.md" },
              },
            ],
          },
        },
      }),
    }),
    code: "review-checkpoint-out-of-range",
    target: "routing[1].repeat.reviewCheckpoint.interval",
  },
  {
    title: "an invalid schema asset",
    manifest: manifest({
      inputs: {
        doc: { type: "file", description: "the doc", schema: "s.json" },
      },
    }),
    text: new Map([...okText, ["s.json", "{ not valid json"]]),
    code: "invalid-schema-asset",
    target: "inputs.doc.schema",
  },
  {
    title: "a schema with a $ref pointing outside the document",
    manifest: manifest({
      inputs: {
        doc: { type: "file", description: "the doc", schema: "s.json" },
      },
    }),
    text: new Map([...okText, ["s.json", '{"$ref":"other.json#/x"}']]),
    code: "invalid-schema-asset",
    target: "inputs.doc.schema",
  },
  {
    title: "a supported platform that resolves no command invocation",
    manifest: manifest({
      routing: routing({
        seed: {
          id: "seed",
          kind: "command",
          requires: ["doc"],
          produces: [{ name: "v", type: "verdict" }],
          command: { executable: "", arguments: [{ asset: "run.sh" }] },
        },
      }),
    }),
    code: "command-invocation-unresolved",
    target: "seed",
  },
  {
    title: "a reference to an asset that is not declared",
    manifest: manifest({
      routing: routing({
        group: {
          repeat: {
            until: "v",
            reviewCheckpoint: { interval: 5, message: "continue?" },
            steps: [
              {
                id: "a",
                kind: "agent",
                session: "s",
                requires: ["doc"],
                prompt: { asset: "ghost.md" },
              },
            ],
          },
        },
      }),
    }),
    code: "unresolved-asset-reference",
    target: "a",
  },
  {
    title: "a reference to an asset of the wrong kind",
    manifest: manifest({
      routing: routing({
        group: {
          repeat: {
            until: "v",
            reviewCheckpoint: { interval: 5, message: "continue?" },
            steps: [
              {
                id: "a",
                kind: "agent",
                session: "s",
                requires: ["doc"],
                prompt: { asset: "run.sh" },
              },
            ],
          },
        },
      }),
    }),
    code: "asset-reference-kind-mismatch",
    target: "a",
  },
  {
    title: "a Command producing a type outside its fixed verdict/text contract",
    manifest: manifest({
      routing: routing({
        seed: {
          id: "seed",
          kind: "command",
          requires: ["doc"],
          produces: [
            { name: "v", type: "verdict" },
            { name: "f", type: "file" },
          ],
          command: { executable: "bash", arguments: [{ asset: "run.sh" }] },
        },
      }),
    }),
    code: "produces-type-unsupported",
    target: "seed",
  },
  {
    title: "a human-gate Step inside a Repeat span (#108)",
    manifest: manifest({
      routing: routing({
        group: {
          repeat: {
            until: "v",
            reviewCheckpoint: { interval: 5, message: "continue?" },
            steps: [
              {
                id: "run",
                kind: "command",
                requires: ["doc"],
                produces: [{ name: "v", type: "verdict" }],
                command: {
                  executable: "bash",
                  arguments: [{ asset: "run.sh" }],
                },
              },
              {
                id: "gate",
                kind: "human-gate",
                shape: "approve-reject",
                message: "ok?",
              },
            ],
          },
        },
      }),
    }),
    code: "human-gate-in-repeat",
    target: "routing[1].repeat.steps",
  },
  {
    // An agent-authored Verdict would let assistant output choose the Routing
    // (ADR 0020); an Agent Step produces only validated `text` receipts (#215).
    title: "an agent Step that declares a non-text output",
    manifest: manifest({
      routing: [
        {
          id: "write",
          kind: "agent",
          session: "s",
          requires: ["doc"],
          prompt: { asset: "p.md" },
          produces: [{ name: "out", type: "verdict" }],
        },
      ],
    }),
    code: "agent-produces-unsupported",
    target: "write",
  },
  {
    title: "an interactive-agent Step that declares produces",
    manifest: manifest({
      routing: [
        {
          id: "grill",
          kind: "interactive-agent",
          session: "s",
          requires: ["doc"],
          prompt: { asset: "p.md" },
          produces: [{ name: "out", type: "text" }],
        },
      ],
    }),
    code: "agent-produces-unsupported",
    target: "grill",
  },
  {
    title: "suggestions on an approve-reject gate (#213)",
    manifest: manifest({
      routing: [
        {
          id: "gate",
          kind: "human-gate",
          shape: "approve-reject",
          message: "ok?",
          suggestions: ["yes"],
        },
      ],
    }),
    code: "gate-suggestions-unsupported",
    target: "gate",
  },
];

test("an agent Step's declared text output composes and binds for a later prompt (#215)", () => {
  const findings = run(
    manifest({
      routing: [
        {
          id: "publish",
          kind: "agent",
          session: "s",
          requires: ["doc"],
          prompt: { asset: "p.md" },
          produces: [{ name: "spec-ref", type: "text" }],
        },
        {
          id: "tickets",
          kind: "agent",
          session: "s",
          requires: ["spec-ref"],
          prompt: { asset: "t.md" },
        },
      ],
      assets: [
        { path: "p.md", kind: "prompt" },
        { path: "t.md", kind: "prompt" },
      ],
    }),
    new Map([
      ["p.md", "use {{artifact:doc}}"],
      ["t.md", "slice {{artifact:spec-ref}}"],
    ]),
  );
  assert.deepEqual(findings, []);
});

for (const testCase of cases) {
  test(`flags ${testCase.title} with a distinct code`, () => {
    const findings = run(testCase.manifest, testCase.text);
    assert.deepEqual(
      findings.map((finding) => ({
        code: finding.code,
        target: finding.target,
      })),
      [{ code: testCase.code, target: testCase.target }],
      JSON.stringify(findings, null, 2),
    );
    assert.equal(findings[0].severity, "error");
  });
}

test("every composition rule owns a distinct stable code", () => {
  const codes = new Set(cases.map((testCase) => testCase.code));
  // Eleven rules; the missing/wrong-kind asset rule carries two codes (twelve),
  // plus the Agent-produces rule (#116) makes thirteen, plus the
  // gate-suggestions rule (#213) makes fourteen.
  assert.equal(codes.size, 14);
});

test("accepts an interactive-agent Step inside a Verdict-driven Repeat span (#216)", () => {
  const findings = run(
    manifest({
      routing: routing({
        group: {
          repeat: {
            until: "v",
            reviewCheckpoint: { interval: 5, message: "continue?" },
            steps: [
              {
                id: "run",
                kind: "command",
                requires: ["doc"],
                produces: [{ name: "v", type: "verdict" }],
                command: {
                  executable: "bash",
                  arguments: [{ asset: "run.sh" }],
                },
              },
              {
                id: "grill",
                kind: "interactive-agent",
                session: "s",
                requires: ["doc"],
                prompt: { asset: "p.md" },
              },
            ],
          },
        },
      }),
    }),
  );
  assert.deepEqual(findings, []);
});

test("flags a duplicate Step id", () => {
  const findings = run(
    manifest({
      routing: routing({
        seed: {
          id: "run",
          kind: "command",
          requires: ["doc"],
          produces: [{ name: "v", type: "verdict" }],
          command: { executable: "bash", arguments: [{ asset: "run.sh" }] },
        },
      }),
    }),
  );
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["duplicate-step-id"],
    JSON.stringify(findings, null, 2),
  );
  assert.equal(findings[0].target, "run");
});

test("flags a prompt asset that is not valid UTF-8", () => {
  const findings = run(
    manifest(),
    new Map<string, string | null>([...okText, ["p.md", null]]),
  );
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["invalid-prompt-asset"],
    JSON.stringify(findings, null, 2),
  );
  assert.equal(findings[0].target, "a");
});

// A declared Agent output name becomes a receipt file name (#215), so it must be one
// safe path segment, and one Step may not declare the same name twice.
for (const [title, produces] of [
  ["a traversal name", [{ name: "../../catalog", type: "text" as const }]],
  ["a dot-dot name", [{ name: "..", type: "text" as const }]],
  ["a name with a separator", [{ name: "a/b", type: "text" as const }]],
  [
    "a duplicated name",
    [
      { name: "spec-ref", type: "text" as const },
      { name: "spec-ref", type: "text" as const },
    ],
  ],
] as const) {
  test(`flags an agent Step output with ${title}`, () => {
    const findings = run(
      manifest({
        routing: [
          {
            id: "publish",
            kind: "agent",
            session: "s",
            requires: ["doc"],
            prompt: { asset: "p.md" },
            produces,
          },
        ],
      }),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.code, finding.target]),
      [["agent-produces-unsupported", "publish"]],
    );
  });
}
