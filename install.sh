#!/bin/sh

set -eu

candidate_dir=""
requested_version=""
modify_path=true

usage() {
  cat <<'EOF'
Secant POSIX installer

Usage: install.sh [--version <version>] [--no-modify-path]

Options:
  -h, --help              Show this help.
  -v, --version VERSION   Install an exact release version (latest by default).
      --no-modify-path    Do not update the current shell's profile.
EOF
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

validate_version() {
  version_value=$1
  version_source=$2
  case "$version_value" in
    "" | *[!0-9A-Za-z.+-]*) fail "Invalid $version_source version: $version_value" ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    -v | --version)
      [ "$#" -ge 2 ] || fail "$1 requires a version"
      requested_version=$2
      shift 2
      ;;
    --no-modify-path)
      modify_path=false
      shift
      ;;
    --candidate-dir)
      [ "$#" -ge 2 ] || fail "$1 requires a directory"
      candidate_dir=$2
      shift 2
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

if [ -n "$requested_version" ]; then
  requested_version=${requested_version#v}
  validate_version "$requested_version" exact
fi

case "$(uname -s)" in
  Darwin)
    os=darwin
    manifest_os=macos
    ;;
  Linux)
    os=linux
    manifest_os=linux
    ;;
  MINGW* | MSYS* | CYGWIN*)
    os=windows
    manifest_os=windows
    ;;
  *)
    os=unknown
    manifest_os=unknown
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) cpu=arm64 ;;
  x86_64 | amd64) cpu=x64 ;;
  *) cpu=unknown ;;
esac

target="$os-$cpu"
case "$target" in
  darwin-arm64 | linux-x64) ;;
  *) fail "Unsupported platform: $target. Secant supports macOS arm64 and Linux x64." ;;
esac

manifest_file=candidate-manifest.json
checksums_file=SHA256SUMS
license_file=LICENSE
notices_file=THIRD-PARTY-NOTICES.md
executable=secant
install_parent=$HOME/.secant
install_dir=$install_parent/bin
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/secant-install.XXXXXX")
install_stage=""
next_link=""

cleanup() {
  rm -rf "$temporary_dir"
  if [ -n "$install_stage" ]; then
    rm -rf "$install_stage"
  fi
  if [ -n "$next_link" ]; then
    rm -f "$next_link"
  fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

download() {
  download_name=$1
  download_destination=$2
  if [ -n "$candidate_dir" ]; then
    [ -f "$candidate_dir/$download_name" ] ||
      fail "Local candidate file not found: $candidate_dir/$download_name"
    cp "$candidate_dir/$download_name" "$download_destination"
    return
  fi

  command -v curl >/dev/null 2>&1 || fail "curl is required to install Secant"
  if [ -n "$requested_version" ]; then
    release_path="download/v$requested_version"
  else
    release_path=latest/download
  fi
  curl -fsSL \
    "https://github.com/secantdev/secant/releases/$release_path/$download_name" \
    -o "$download_destination"
}

manifest_value() {
  manifest_value_field=$1
  # The assembler owns a deliberately small string-only projection of JSON.
  # POSIX provides no JSON parser, so recognize only those unique scalar lines
  # instead of growing a general parser or requiring jq at install time.
  awk -v field="$manifest_value_field" '
    $0 ~ "\\\"" field "\\\"[[:space:]]*:" {
      value = $0
      sub(/^[^:]*:[[:space:]]*"/, "", value)
      sub(/".*/, "", value)
      count += 1
    }
    END {
      if (count != 1) exit 1
      print value
    }
  ' "$temporary_dir/$manifest_file"
}

target_manifest_value() {
  target_manifest_field=$1
  awk -v target="$target" -v field="$target_manifest_field" '
    $0 ~ "\\\"key\\\"[[:space:]]*:[[:space:]]*\\\"" target "\\\"" {
      target_count += 1
      selected = 1
      next
    }
    selected && $0 ~ "\\\"" field "\\\"[[:space:]]*:" {
      value = $0
      sub(/^[^:]*:[[:space:]]*"/, "", value)
      sub(/".*/, "", value)
      field_count += 1
    }
    selected && /^[[:space:]]*},?[[:space:]]*$/ { selected = 0 }
    END {
      if (target_count != 1 || field_count != 1) exit 1
      print value
    }
  ' "$temporary_dir/$manifest_file"
}

sha256_file() {
  sha256_path=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$sha256_path" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$sha256_path" | awk '{ print $1 }'
  else
    fail "sha256sum or shasum is required to verify Secant"
  fi
}

download "$manifest_file" "$temporary_dir/$manifest_file"
download "$checksums_file" "$temporary_dir/$checksums_file"

candidate_version=$(manifest_value version) || fail "Candidate manifest version is malformed"
validate_version "$candidate_version" candidate
if [ -n "$requested_version" ]; then
  [ "$candidate_version" = "$requested_version" ] ||
    fail "Candidate version $candidate_version does not match requested version $requested_version"
fi

[ "$(target_manifest_value os)" = "$manifest_os" ] || fail "Candidate target OS identity is invalid"
[ "$(target_manifest_value cpu)" = "$cpu" ] || fail "Candidate target CPU identity is invalid"
[ "$(target_manifest_value executable)" = "$executable" ] || fail "Candidate executable identity is invalid"

# Archive facts come from the selected target block emitted from
# scripts/targets.ts; the installer owns only its two supported host keys.
archive=$(target_manifest_value archive) || fail "Candidate archive identity is invalid"
case "$archive" in
  "" | *[!0-9A-Za-z._-]*) fail "Candidate archive identity is invalid" ;;
esac
archive_type=$(target_manifest_value archiveType) || fail "Candidate archive type is invalid"
case "$archive_type" in
  zip | tar.gz) ;;
  *) fail "Candidate archive type is invalid" ;;
esac

archive_path=$temporary_dir/$archive
download "$archive" "$archive_path"
expected_archive_sha256=$(
  awk -v archive="$archive" '
    $2 == archive && NF == 2 { count += 1; digest = $1 }
    END {
      if (count != 1) exit 1
      print digest
    }
  ' "$temporary_dir/$checksums_file"
) || fail "$archive must appear exactly once in $checksums_file"
actual_archive_sha256=$(sha256_file "$archive_path")
[ "$actual_archive_sha256" = "$expected_archive_sha256" ] ||
  fail "$archive checksum does not match $checksums_file"
[ "$actual_archive_sha256" = "$(target_manifest_value archiveSha256)" ] ||
  fail "$archive checksum does not match $manifest_file"

expected_layout=$temporary_dir/expected-layout
actual_layout=$temporary_dir/actual-layout
printf '%s\n' "$license_file" "$notices_file" "$executable" | LC_ALL=C sort >"$expected_layout"
case "$archive_type" in
  zip)
    command -v unzip >/dev/null 2>&1 || fail "unzip is required to install Secant on macOS"
    unzip -Z1 "$archive_path" | LC_ALL=C sort >"$actual_layout"
    ;;
  tar.gz)
    command -v tar >/dev/null 2>&1 || fail "tar is required to install Secant on Linux"
    tar -tzf "$archive_path" | LC_ALL=C sort >"$actual_layout"
    ;;
esac
cmp -s "$expected_layout" "$actual_layout" ||
  fail "$archive layout must contain only $executable, $license_file, and $notices_file"

extract_dir=$temporary_dir/extracted
mkdir "$extract_dir"
case "$archive_type" in
  zip) unzip -q "$archive_path" -d "$extract_dir" ;;
  tar.gz) tar -xzf "$archive_path" -C "$extract_dir" ;;
esac

[ "$(sha256_file "$extract_dir/$executable")" = "$(target_manifest_value binarySha256)" ] ||
  fail "Candidate executable checksum is invalid"
[ "$(sha256_file "$extract_dir/$license_file")" = "$(manifest_value licenseSha256)" ] ||
  fail "Candidate $license_file checksum is invalid"
[ "$(sha256_file "$extract_dir/$notices_file")" = "$(manifest_value noticesSha256)" ] ||
  fail "Candidate $notices_file checksum is invalid"
chmod 755 "$extract_dir/$executable"

if [ "$os" = darwin ]; then
  command -v codesign >/dev/null 2>&1 || fail "codesign is required to verify Secant on macOS"
  codesign --verify --deep --strict "$extract_dir/$executable" ||
    fail "Candidate executable failed strict macOS signature verification"
fi

reported_version=$("$extract_dir/$executable" --version) ||
  fail "Candidate executable could not report its version"
[ "$reported_version" = "$candidate_version" ] ||
  fail "Candidate executable reported version $reported_version instead of $candidate_version"

# Stage one immutable layout on the destination filesystem, then atomically
# switch the fixed bin path. The previous executable and its legal material
# therefore remain one coherent installation until the single rename.
releases_dir=$install_parent/releases
release_name=$candidate_version-$actual_archive_sha256
release_dir=$releases_dir/$release_name
mkdir -p "$releases_dir"
if [ -e "$install_dir" ] && [ ! -L "$install_dir" ]; then
  fail "$install_dir exists but is not a Secant-managed installation"
fi
if [ ! -d "$release_dir" ]; then
  install_stage=$releases_dir/.install.$$
  rm -rf "$install_stage"
  mkdir "$install_stage"
  cp "$extract_dir/$license_file" "$install_stage/$license_file"
  cp "$extract_dir/$notices_file" "$install_stage/$notices_file"
  cp "$extract_dir/$executable" "$install_stage/$executable"
  chmod 755 "$install_stage/$executable"
  mv "$install_stage" "$release_dir"
  install_stage=""
else
  [ "$(sha256_file "$release_dir/$executable")" = "$(target_manifest_value binarySha256)" ] ||
    fail "Existing staged release has an invalid executable"
  [ "$(sha256_file "$release_dir/$license_file")" = "$(manifest_value licenseSha256)" ] ||
    fail "Existing staged release has invalid legal material"
  [ "$(sha256_file "$release_dir/$notices_file")" = "$(manifest_value noticesSha256)" ] ||
    fail "Existing staged release has invalid legal material"
fi
next_link=$install_parent/.bin.$$
rm -f "$next_link"
ln -s "releases/$release_name" "$next_link"
if mv --help 2>&1 | grep -q no-target-directory; then
  # GNU mv spells the no-dereference operation as --no-target-directory.
  mv -fT "$next_link" "$install_dir"
else
  # BSD mv uses -h to replace a symlink-to-directory rather than following it.
  mv -fh "$next_link" "$install_dir"
fi
next_link=""

print_install_result() {
  printf 'Secant %s installed at %s.\n' "$candidate_version" "$install_dir/$executable"
  if [ "$os" = darwin ]; then
    printf 'Run Secant from Terminal; do not double-click a downloaded executable.\n'
  fi
}

path_instruction='export PATH="$HOME/.secant/bin:$PATH"'
if [ "$modify_path" = false ]; then
  print_install_result
  printf 'To persist Secant on PATH, add this exact line to your shell profile:\n%s\n' "$path_instruction"
  exit 0
fi

case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *)
    case "${SHELL:-}" in
      */zsh) profile=$HOME/.zshrc ;;
      */bash) profile=$HOME/.bashrc ;;
      *) profile=$HOME/.profile ;;
    esac
    touch "$profile"
    if ! grep -Fqx "$path_instruction" "$profile"; then
      printf '\n# Secant\n%s\n' "$path_instruction" >>"$profile"
    fi
    printf 'Added Secant to PATH in %s. Restart your shell to use it.\n' "$profile"
    ;;
esac

print_install_result
