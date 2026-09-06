# Adopt Secant As The Product, Package, And Command Name

The product built on this map is named **Secant**. It replaces Crucible, the working name every prior decision was written under, and Pivlo, the
working naming decision recorded on 2026-08-15. The [naming decision](https://github.com/DevFlow-HQ/devflow-cli/issues/24) fixes this because the
[Crucible research](https://github.com/DevFlow-HQ/devflow-cli/issues/12) found material trademark, adjacent-product, package, executable, and domain
conflicts, and the two constraints the decision was made under are that an English reader must be able to say and spell the name with no cue, and
that an exact short domain is not required. Secant is an ordinary dictionary word with one reading, and its meaning, a line that reaches a curve by
connecting two points on it, is a plain story for a tool that reaches an outcome by routing between Steps.

## Identifiers

| Identifier          | Value               | Why this shape                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product             | Secant              | Bare word; no pronunciation guide needed.                                                                                                                                                                                                                                                                                                         |
| GitHub organization | `secant-dev`        | The bare `secant` login is a dormant user account from 2017, so the organization is qualified. `secant-dev` was created as an empty placeholder on 2026-09-06 to hold the name; at the cut, the placeholder is deleted and `DevFlow-HQ` is renamed to `secant-dev`, then `DevFlow-HQ` is re-registered empty so nobody can inherit its redirects. |
| Repository          | `secant-dev/secant` | One repository, one product.                                                                                                                                                                                                                                                                                                                      |
| npm package         | `secant`            | Unpublished on npm; `@secant-dev/secant` is the fallback if the bare name cannot be claimed under authentication.                                                                                                                                                                                                                                 |
| Executable          | `secant`            | No package on npm, PyPI, crates.io, RubyGems, NuGet, Homebrew, conda-forge, Docker Hub, Debian, Ubuntu, Fedora, AUR, Chocolatey, winget, or Scoop installs a `secant` command.                                                                                                                                                                    |
| Website             | `secant.sh`         | The only unregistered domain among `.com`, `.io`, `.dev`, `.app`, and `.sh`. A domain is not required, so it is registered if convenient and never blocks a release.                                                                                                                                                                              |

## Coexistence accepted

The [Secant research](https://github.com/DevFlow-HQ/devflow-cli/issues/24#issuecomment-5559484083) found no live software product named Secant in
this product's category. The name is accepted alongside Secant Group, an unrelated medical-textiles manufacturer that has held `secant.com` since 1995;
Secant Pay, a small crypto-payments SDK on npm; and historical uses that only add search noise: a concluded EU cybersecurity project, an inactive
security-assessment tool, and a 2021 machine-learning paper. Two GitHub organizations also carry the word: Secant Labs (`secantlabs`, created
2026-07, interactive undergraduate-mathematics sandboxes) and an empty 2024 organization named Secant that owns `secant.app`. Search results will
also always include the trigonometric function.

## Gates before public use

Secant is the decided name for planning and for the slice-zero rename below. Public announcement, publishing to npm, and any claim of exclusive
ownership wait for:

1. Professional trademark clearance in launch jurisdictions covering software and SaaS classes and, because of Secant Pay, payment-services classes.
   Every automated trademark database was unreachable during research, so trademark status is unknown, not clean.
2. The rename of `DevFlow-HQ` into the reserved `secant-dev` name and of the repository to `secant-dev/secant`, and an authenticated `npm publish --dry-run` for
   `secant`. The npm user and organization pages returned access errors during research, so the npm scope is unverified.
3. Registrar confirmation of `secant.sh` if a website is wanted.
4. A native-speaker check in each launch market. Romance-language `secante` means drying or blotting and is informally "annoying" in some dialects;
   nothing offensive was found elsewhere, but that is absence of evidence only.

## Migration point

The rename lands in the slice-zero cut defined by [ADR 0026](./0026-replace-legacy-devflow-in-place-by-wholesale-deletion.md), in the same commit that
deletes legacy DevFlow. That commit renames the package name, the bin, the repository, the organization, `CONTEXT.md`, `README.md`, and agent guidance
to Secant, so no target code is ever written under the DevFlow or Crucible names. Nothing is published from that commit. Existing ADRs and closed
tickets keep the word Crucible as the historical working name and are not rewritten; a reader maps Crucible to Secant.

## Rejected options

- **Crucible.** Exact-name trademark, adjacent-product, package, executable, and domain conflicts established by the Crucible research.
- **Pivlo.** Current exact-name smart-home and 3D/AR products, an occupied bare GitHub identity, and no meaning to carry.
- **Coend.** The only candidate with an empty brand everywhere, but the word means nothing to anyone outside category theory.
- **Coset, Cospan, Operad, Skolem.** Each has a live neighbour in this product's own category: two active crypto developer brands; a Rust TUI for
  AI-agent development literally named `cospan`; two npm packages that already install an `operad` command; a funded and acquired DeFi company.
- **Sulba, Padovan.** Clean registries, but an active AI-consulting firm named Sulba Inc. and unstable transliteration for one; surname noise, a
  century-old Italian manufacturer, and visual closeness to "Padawan" for the other.
- **Aleph and the Hebrew letters.** Aleph is held by two AI companies and three well-known frameworks; the readable letters that were free
  (Samekh, Heth) fail the no-cue pronunciation rule.
- **Plain Greek letters.** Every one checked is saturated.
