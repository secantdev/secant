#!/usr/bin/env bash
#
# POSIX installer consumer scenario. Drives root install.sh through a real shell
# against the assembled local candidate, the way a consumer receives it, and
# restores the coverage the #185 subprocess-test migration retired
# (tests/release/posix-installer.test.ts). The Windows sibling shape lives in
# scripts/powershell-installer-consumer.ps1; see docs/agents/release-consumers.md.
#
# Usage: posix-installer-consumer.sh --scenario supported|unsupported \
#          --candidate-dir <dir>
#
#   supported   (macOS arm64, Linux x64): install/replace the real candidate,
#               prove SECANT_HOME independence, exact-version selection, PATH
#               idempotency, and that a malformed candidate (checksum, layout,
#               version, legal material) is refused while the existing install
#               is preserved.
#   unsupported (Windows x64): refuse the native target before any candidate
#               access.

set -euo pipefail

scenario=""
candidate_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --scenario)
      scenario=${2:-}
      shift 2
      ;;
    --candidate-dir)
      candidate_dir=${2:-}
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

project_root=$(cd "$(dirname "$0")/.." && pwd)
installer=$project_root/install.sh

fail() {
  echo "POSIX installer consumer ($scenario): $1" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

if [ "$scenario" = unsupported ]; then
  missing_candidate="${TMPDIR:-/tmp}/secant-candidate-must-not-be-read-$$"
  rm -rf "$missing_candidate"
  if output=$(sh "$installer" --candidate-dir "$missing_candidate" --no-modify-path 2>&1); then
    fail "the installer accepted the native unsupported target: $output"
  fi
  printf '%s\n' "$output" | grep -F 'Unsupported platform: windows-x64' >/dev/null ||
    fail "the unsupported-target refusal was not explicit: $output"
  if printf '%s\n' "$output" | grep -F "$missing_candidate" >/dev/null; then
    fail "the installer accessed its candidate source before refusing the target"
  fi
  if [ -e "$missing_candidate" ]; then
    fail "the installer touched the candidate source before refusing the target"
  fi
  echo "POSIX installer refused the native unsupported target before reading candidates."
  exit 0
fi

if [ "$scenario" != supported ]; then
  fail "unknown scenario '$scenario' (expected supported or unsupported)"
fi

[ -n "$candidate_dir" ] || fail "--candidate-dir is required for the supported scenario"
original_candidate=$(cd "$candidate_dir" && pwd)
manifest_name=candidate-manifest.json
sums_name=SHA256SUMS

version=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$original_candidate/$manifest_name" | head -n 1)
[ -n "$version" ] || fail "could not read the candidate version"

case "$(uname -s)" in
  Darwin) archive=secant-darwin-arm64.zip ;;
  Linux) archive=secant-linux-x64.tar.gz ;;
  *) fail "the supported scenario runs on macOS arm64 and Linux x64 only" ;;
esac

test_root=$(mktemp -d "${TMPDIR:-/tmp}/secant-posix-installer.XXXXXX")
test_home=$test_root/home
app_home=$test_root/application-data
local_candidate=$test_root/candidate
install_dir=$test_home/.secant/bin
executable=$install_dir/secant
mkdir -p "$test_home"
trap 'rm -rf "$test_root"' EXIT

# The installer keys its profile choice off SHELL; pin zsh so PATH idempotency
# writes one predictable profile.
export HOME="$test_home"
export SECANT_HOME="$app_home"
export SHELL=/bin/zsh

reset_local_candidate() {
  rm -rf "$local_candidate"
  mkdir -p "$local_candidate"
  cp -R "$original_candidate/." "$local_candidate/"
}

# Rewrite the archiveSha256 of the host target only (the block whose archive
# field matches), mirroring install.sh's own single-target awk selection.
set_target_archive_digest() {
  digest=$1
  awk -v archive="$archive" -v digest="$digest" '
    $0 ~ "\"archive\"[[:space:]]*:[[:space:]]*\"" archive "\"" { in_target = 1 }
    in_target && /"archiveSha256"[[:space:]]*:/ {
      sub(/"archiveSha256"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"archiveSha256\": \"" digest "\"")
      in_target = 0
    }
    { print }
  ' "$local_candidate/$manifest_name" >"$local_candidate/$manifest_name.tmp"
  mv "$local_candidate/$manifest_name.tmp" "$local_candidate/$manifest_name"
}

# Rewrite a unique top-level string field (only the manifest header carries
# version/licenseSha256; the target blocks do not).
set_manifest_field() {
  field=$1
  value=$2
  awk -v field="$field" -v value="$value" '
    !done && $0 ~ "\"" field "\"[[:space:]]*:" {
      sub("\"" field "\"[[:space:]]*:[[:space:]]*\"[^\"]*\"", "\"" field "\": \"" value "\"")
      done = 1
    }
    { print }
  ' "$local_candidate/$manifest_name" >"$local_candidate/$manifest_name.tmp"
  mv "$local_candidate/$manifest_name.tmp" "$local_candidate/$manifest_name"
}

set_sums_digest() {
  digest=$1
  awk -v archive="$archive" -v digest="$digest" '
    $2 == archive { print digest "  " archive; next }
    { print }
  ' "$local_candidate/$sums_name" >"$local_candidate/$sums_name.tmp"
  mv "$local_candidate/$sums_name.tmp" "$local_candidate/$sums_name"
}

run_installer() {
  installer_output_file=$test_root/installer-output
  set +e
  sh "$installer" --candidate-dir "$local_candidate" "$@" >"$installer_output_file" 2>&1
  installer_status=$?
  set -e
  installer_output=$(cat "$installer_output_file")
}

assert_installed_runs() {
  [ -x "$executable" ] || fail "the installer did not preserve an executable at $executable"
  reported=$("$executable" --version) || fail "the installed executable did not run"
  [ "$reported" = "$version" ] ||
    fail "the installed executable reported '$reported' instead of '$version'"
}

# name, expected-substring, then installer args.
assert_failure_preserves() {
  name=$1
  expected=$2
  shift 2
  before=$(sha256_file "$executable")
  run_installer "$@"
  [ "$installer_status" -ne 0 ] || fail "$name was accepted: $installer_output"
  printf '%s\n' "$installer_output" | grep -F "$expected" >/dev/null ||
    fail "$name did not fail at the expected validation: $installer_output"
  after=$(sha256_file "$executable")
  [ "$after" = "$before" ] || fail "$name changed the existing installation"
  assert_installed_runs
}

# --- Install the pristine candidate ------------------------------------------
reset_local_candidate
run_installer --no-modify-path
[ "$installer_status" -eq 0 ] || fail "latest installation failed: $installer_output"
assert_installed_runs
[ -f "$install_dir/LICENSE" ] || fail "the installer did not install LICENSE"
[ -f "$install_dir/THIRD-PARTY-NOTICES.md" ] ||
  fail "the installer did not install THIRD-PARTY-NOTICES.md"
[ ! -e "$app_home/bin/secant" ] || fail "the installer used SECANT_HOME as its installation root"
printf '%s\n' "$installer_output" | grep -F 'export PATH="$HOME/.secant/bin:$PATH"' >/dev/null ||
  fail "the installer did not print the persistent PATH instruction"
if [ "$(uname -s)" = Darwin ]; then
  printf '%s\n' "$installer_output" |
    grep -F 'Run Secant from Terminal; do not double-click a downloaded executable.' >/dev/null ||
    fail "the installer did not print the macOS Terminal guidance"
fi

# --- Exact-version selection --------------------------------------------------
reset_local_candidate
run_installer --version "$version" --no-modify-path
[ "$installer_status" -eq 0 ] || fail "exact-version installation failed: $installer_output"
assert_installed_runs
reset_local_candidate
run_installer --version "v$version" --no-modify-path
[ "$installer_status" -eq 0 ] ||
  fail "v-prefixed exact-version installation failed: $installer_output"
assert_installed_runs
reset_local_candidate
assert_failure_preserves "a mismatched exact version" "does not match requested version" \
  --version 999.0.0 --no-modify-path

# --- Malformed candidate refusals preserve the install -----------------------
reset_local_candidate
printf 'tampered' >>"$local_candidate/$archive"
assert_failure_preserves "a tampered checksum" "checksum does not match" --no-modify-path

reset_local_candidate
layout_dir=$test_root/layout
rm -rf "$layout_dir"
mkdir -p "$layout_dir"
case "$archive" in
  *.zip) (cd "$layout_dir" && unzip -q "$local_candidate/$archive") ;;
  *.tar.gz) tar -xzf "$local_candidate/$archive" -C "$layout_dir" ;;
esac
printf 'unexpected\n' >"$layout_dir/unexpected.txt"
rm -f "$local_candidate/$archive"
# Repack with explicit member names (no leading `./`) so the only layout
# difference the installer sees is the extra file, not a path-prefix artefact.
layout_members="secant LICENSE THIRD-PARTY-NOTICES.md unexpected.txt"
case "$archive" in
  *.zip) (cd "$layout_dir" && zip -q -X "$local_candidate/$archive" $layout_members) ;;
  *.tar.gz) (cd "$layout_dir" && tar -czf "$local_candidate/$archive" $layout_members) ;;
esac
new_digest=$(sha256_file "$local_candidate/$archive")
set_sums_digest "$new_digest"
set_target_archive_digest "$new_digest"
assert_failure_preserves "an unexpected archive layout" "layout must contain only" --no-modify-path

reset_local_candidate
set_manifest_field version "../../outside"
assert_failure_preserves "a malformed candidate version" "Invalid candidate version" --no-modify-path

reset_local_candidate
set_manifest_field licenseSha256 "$(printf '0%.0s' $(seq 1 64))"
assert_failure_preserves "a legal-material digest mismatch" "LICENSE checksum is invalid" \
  --no-modify-path

# --- PATH modification is idempotent -----------------------------------------
reset_local_candidate
run_installer
[ "$installer_status" -eq 0 ] || fail "PATH-modifying installation failed: $installer_output"
run_installer
[ "$installer_status" -eq 0 ] || fail "repeated PATH-modifying installation failed: $installer_output"
path_lines=$(grep -F -c 'export PATH="$HOME/.secant/bin:$PATH"' "$test_home/.zshrc" || true)
[ "$path_lines" = "1" ] ||
  fail "PATH modification was not idempotent ($path_lines profile entries)"

echo "POSIX installer installed and ran the local candidate and preserved it across malformed-candidate failures."
