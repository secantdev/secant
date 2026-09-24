# Release evidence checklist

Copy this template for a release or non-publishing validation candidate. Every
digest and report must name the same immutable candidate assembled by the named
workflow run. A checked item is an attestation, not a request to rebuild it.

## Candidate identity

- Ref/tag: `<ref>`
- Commit: `<full SHA>`
- Workflow run: `<URL and run id>`
- Secant version: `<version>`
- Candidate digests:
  - Windows x64 archive and binary SHA-256: `<archive>` / `<binary>`
  - macOS arm64 archive and binary SHA-256: `<archive>` / `<binary>`
  - Linux x64 archive and binary SHA-256: `<archive>` / `<binary>`
  - npm launcher and platform-package digests: `<digests>`
- Shipped Bundles (`id@version` and digest, as the approval summary prints them): `<bundles>`

## Automated gates

- [ ] Exact ref/commit/version agreement
- [ ] Canonical three-OS check
- [ ] Native compiled-binary smoke on Windows, macOS, and Linux
- [ ] Candidate archive, installer, and npm consumer checks
- [ ] Signature and candidate checksum verification
- [ ] Authenticated read-only npm identity and publish dry-runs
- [ ] Artifact-level licence and third-party-notices gate
- Gate evidence: `<workflow jobs/URLs>`

## Human reports

- [ ] Installed Claude Code report attached; candidate binary SHA-256 matches
- [ ] Installed Codex report attached; candidate binary SHA-256 matches
- [ ] Windows Terminal trigger decision recorded
- [ ] Legacy-conhost notice observation recorded (observed only; not a support claim)
- Claude Code report: `<report URL>`
- Codex report: `<report URL>`
- Windows Terminal basis: `<fresh report URL | carried report name>`
- Named carry-forward comparison, when applicable: `<comparison URL or n/a>`

Recording/replay is deterministic Adapter evidence only. It cannot fill an
installed-Harness report, real-terminal report, or three-OS native-binary row.

## Claims and public-use gates

- [ ] `docs/support-matrix.md` OS/architecture claims cite native binary evidence
- [ ] Terminal claims cite a fresh or validly carried real-terminal report
- [ ] Harness claims cite the matching real installed-Harness report and version
- [ ] No replay result is cited as real-Harness or three-OS evidence
- [ ] ADR 0028 trademark clearance recorded for launch jurisdictions
- [ ] ADR 0028 npm/package-identity gate remains satisfied
- [ ] ADR 0028 website decision recorded; registrar confirmation attached when `secant.sh` is wanted, otherwise explicitly marked not applicable
- [ ] ADR 0028 launch-market native-speaker checks recorded
- Support-matrix change: `<commit/diff>`
- Public-use evidence: `<URLs or explicit not-cleared status>`

## Approval

- Candidate kind: `<non-publishing validation | release>`
- Final reviewer: `<identity>`
- Protected-environment approval: `<workflow approval URL or n/a>`
- Approval UTC timestamp: `<timestamp>`
- [ ] Reviewer confirmed every report and claim is bound to the ref, commit,
      workflow run, version, and digests above
