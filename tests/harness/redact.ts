// Redaction for recorded Harness fixtures (#115). A recording is byte-faithful,
// so before it is committed the recorder substitutes the secrets Secant or the
// host introduced — the home directory, the user name, the bridge bearer token,
// and any credential the scenario deliberately fed in — each substitution named
// in `recording.json`'s `redactions`. It then refuses to write a recording whose
// bytes still match a credential pattern, so a fixture can never carry a live
// secret (ADR 0022).
//
// The credential pattern set and the `envSecrets` sweep are Vendored from OpenCode
// (packages/http-recorder/src/redaction.ts, commit 1ead9e3d7f) so the same shapes
// are caught here. This is a test-only copy; the src/-scoped vendor-provenance
// check does not reach it, so this header comment carries its provenance (#127 D5).

/** One substitution class the recorder applied, as it appears in the sidecar. */
export interface Redaction {
  readonly placeholder: string;
  readonly reason: string;
}

/** A literal secret to substitute, with the placeholder and the reason recorded
 *  when at least one occurrence is replaced. */
export interface KnownSecret {
  /** The literal string to replace. Empty or whitespace-only values are ignored
   *  (a blank home directory or user name must never blank out real bytes). */
  readonly value: string;
  readonly placeholder: string;
  readonly reason: string;
}

export interface RedactionResult {
  readonly text: string;
  readonly redactions: Redaction[];
}

/** Credential shapes that must never survive into a committed fixture. */
export const CREDENTIAL_PATTERNS: readonly {
  readonly label: string;
  readonly pattern: RegExp;
}[] = [
  { label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  {
    label: "OpenAI-style API key",
    pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}/,
  },
  {
    label: "Anthropic OAuth token",
    pattern: /\bsk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}/,
  },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

// Environment-variable names and values that look like a secret. A secret-shaped
// env var on the recording host is substituted even when the scenario never named
// it, closing the gap where only the eight literal credential patterns caught it.
const ENV_SECRET_NAMES =
  /(?:API|AUTH|BEARER|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i;
const SAFE_ENV_VALUES = new Set(["fixture", "test", "test-key"]);

/** Sweep an environment for secret-shaped variables, as `KnownSecret`s the
 *  recorder folds into its substitution set (Vendored from OpenCode; see header).
 *  A short or explicitly safe value is skipped so ordinary config never blanks
 *  out real bytes. */
export function envSecrets(
  env: NodeJS.ProcessEnv = process.env,
): KnownSecret[] {
  return Object.entries(env).flatMap(([name, value]) => {
    if (!value) return [];
    if (!ENV_SECRET_NAMES.test(name)) return [];
    if (value.length < 12) return [];
    if (SAFE_ENV_VALUES.has(value.toLowerCase())) return [];
    return [
      {
        value,
        placeholder: `«ENV:${name}»`,
        reason: `environment secret ${name}`,
      },
    ];
  });
}

/** Replace every occurrence of each known secret and report the classes applied.
 *  The longest values are substituted first so a secret that contains another
 *  (a token inside a URL, say) is redacted whole rather than in fragments. */
export function redact(
  text: string,
  secrets: readonly KnownSecret[],
): RedactionResult {
  const redactions: Redaction[] = [];
  let out = text;
  const ordered = [...secrets]
    .filter((secret) => secret.value.trim().length > 0)
    .sort((a, b) => b.value.length - a.value.length);
  for (const secret of ordered) {
    if (!out.includes(secret.value)) continue;
    out = out.split(secret.value).join(secret.placeholder);
    if (!redactions.some((entry) => entry.placeholder === secret.placeholder)) {
      redactions.push({
        placeholder: secret.placeholder,
        reason: secret.reason,
      });
    }
  }
  return { text: out, redactions };
}

/** Raised when a recording still matches a credential pattern after redaction. */
export class CredentialLeak extends Error {
  constructor(readonly labels: readonly string[]) {
    super(
      `recording still matches credential pattern(s): ${labels.join(", ")}`,
    );
    this.name = "CredentialLeak";
  }
}

/** The credential labels a text still matches, if any. */
export function findCredentials(text: string): string[] {
  return CREDENTIAL_PATTERNS.filter((entry) => entry.pattern.test(text)).map(
    (entry) => entry.label,
  );
}

/** Refuse a recording that still carries a credential-shaped string, naming the
 *  pattern. Called on the final bytes of every file the recorder is about to write. */
export function assertNoCredentials(text: string): void {
  const labels = findCredentials(text);
  if (labels.length > 0) throw new CredentialLeak(labels);
}
