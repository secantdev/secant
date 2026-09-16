// The recorder's redaction and credential-refusal contract (#115).

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoCredentials,
  CredentialLeak,
  findCredentials,
  redact,
} from "./redact.js";

test("redact substitutes each known secret and names the class applied", () => {
  const text = "cwd /home/ada by ada using Bearer abc";
  const { text: out, redactions } = redact(text, [
    { value: "/home/ada", placeholder: "«HOME»", reason: "home directory" },
    { value: "ada", placeholder: "«USER»", reason: "user name" },
  ]);
  assert.equal(out.includes("/home/ada"), false);
  // The longer secret is replaced first, so the user name inside the path is not
  // fragmented before the whole path is redacted.
  assert.equal(out, "cwd «HOME» by «USER» using Bearer abc");
  assert.deepEqual(redactions, [
    { placeholder: "«HOME»", reason: "home directory" },
    { placeholder: "«USER»", reason: "user name" },
  ]);
});

test("redact ignores blank secrets and reports nothing when none match", () => {
  const { text, redactions } = redact("clean bytes", [
    { value: "", placeholder: "«HOME»", reason: "home directory" },
    { value: "absent", placeholder: "«USER»", reason: "user name" },
  ]);
  assert.equal(text, "clean bytes");
  assert.deepEqual(redactions, []);
});

test("a credential-shaped string is refused with a named reason", () => {
  const leaked =
    'result:"Invalid API key sk-ant-oat01-abcdefghijklmnopqrstuvwxyz012345"';
  assert.ok(findCredentials(leaked).includes("Anthropic API key"));
  assert.throws(
    () => assertNoCredentials(leaked),
    (error: unknown) =>
      error instanceof CredentialLeak &&
      error.labels.includes("Anthropic API key") &&
      /credential pattern/.test(error.message),
  );
});

test("a bearer token is caught even when it survives host redaction", () => {
  assert.throws(
    () =>
      assertNoCredentials(
        "Authorization: Bearer 0123456789abcdef0123456789abcdef",
      ),
    CredentialLeak,
  );
});

test("assertNoCredentials passes a redacted, secret-free recording", () => {
  assert.doesNotThrow(() =>
    assertNoCredentials('{"result":"Not logged in · Please run /login"}'),
  );
});
