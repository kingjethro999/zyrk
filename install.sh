#!/bin/sh
# install.sh - Install the zyrk CLI from GitHub releases (latest) or npm (legacy).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kingjethro999/zyrk/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version v0.9.9   # a specific release
#   curl -fsSL .../install.sh | sh -s -- --npm              # legacy npm package
#
# npm carries zyrk only up to v0.8.9 while registry publishing is unavailable.
# Newer versions ship as package tarballs attached to GitHub releases, each
# with a SHA-256 file. The digest detects a corrupt or truncated download; it
# comes from the same release as the tarball, so it is not a signature.
#
# The tarball is installed with `npm install --global`, which also fetches
# zyrk's runtime dependencies from the npm registry.

set -eu

REPO="kingjethro999/zyrk"
NPM_VERSION="0.8.9"
MODE="github"
VERSION="${ZYRK_VERSION:-}"

usage() {
  cat <<EOF
Install the zyrk CLI.

  sh install.sh                    install the latest GitHub release
  sh install.sh --version vX.Y.Z   install one specific GitHub release
  sh install.sh --npm              install zyrk@$NPM_VERSION from npm (legacy)

Requires Node.js 24 or newer and npm.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --npm) MODE="npm" ;;
    --version)
      [ $# -ge 2 ] || { echo "zyrk install: --version needs a value such as v0.9.9" >&2; exit 2; }
      VERSION="$2"
      shift
      ;;
    --version=*) VERSION="${1#--version=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "zyrk install: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
  shift
done

# --- presentation ------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  BOLD="$(printf '\033[1m')" DIM="$(printf '\033[2m')" RESET="$(printf '\033[0m')"
  GREEN="$(printf '\033[32m')" RED="$(printf '\033[31m')" CYAN="$(printf '\033[36m')"
else
  BOLD="" DIM="" RESET="" GREEN="" RED="" CYAN=""
fi

step() { printf '%s›%s %s\n' "$CYAN" "$RESET" "$*"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
note() { printf '  %s%s%s\n' "$DIM" "$*" "$RESET"; }
die() {
  printf '%s✖%s zyrk install: %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

printf '\n  %szyrk%s %sinstaller%s\n\n' "$BOLD" "$RESET" "$DIM" "$RESET"

# --- prerequisites -----------------------------------------------------------

command -v node >/dev/null 2>&1 ||
  die "Node.js 24 or newer is required. Install it from https://nodejs.org and retry."
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$node_major" -ge 24 ] 2>/dev/null ||
  die "Node.js 24 or newer is required (found $(node -v))."
command -v npm >/dev/null 2>&1 ||
  die "npm is required to place the zyrk executable on your PATH."
ok "Node.js $(node -v) and npm $(npm -v)"

# --- install -----------------------------------------------------------------

if [ "$MODE" = "npm" ]; then
  step "Installing zyrk@$NPM_VERSION from npm (legacy channel)"
  note "npm cannot update past $NPM_VERSION; rerun without --npm for the latest release."
  npm install --global "zyrk@$NPM_VERSION" ||
    die "npm could not install zyrk@$NPM_VERSION."
else
  command -v curl >/dev/null 2>&1 ||
    die "curl is required to download a zyrk release. Install curl, or rerun with --npm."

  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [ -z "$VERSION" ]; then
    step "Resolving the latest zyrk release"
    # The releases/latest page redirects to the newest tag. Reading the
    # redirect avoids the rate-limited API and any JSON parsing.
    latest_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" ||
      die "Could not reach GitHub. Check your network, or rerun with --npm to install zyrk@$NPM_VERSION."
    VERSION="${latest_url##*/}"
  fi
  case "$VERSION" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    [0-9]*.[0-9]*.[0-9]*) VERSION="v$VERSION" ;;
    *) die "Could not determine a release version (got '$VERSION'). Pass one with --version vX.Y.Z." ;;
  esac
  case "$VERSION" in
    *[!A-Za-z0-9.+-]*) die "Release version '$VERSION' contains unsupported characters." ;;
  esac

  # npm pack names the tarball <name>-<version>.tgz, for example zyrk-0.9.9.tgz.
  asset="zyrk-${VERSION#v}.tgz"
  base="https://github.com/$REPO/releases/download/$VERSION"

  step "Downloading $asset from release $VERSION"
  if [ -t 2 ]; then meter="--progress-bar"; else meter="-sS"; fi
  curl -fL "$meter" "$base/$asset" -o "$work/$asset" ||
    die "Release $VERSION has no downloadable '$asset'. Choose another release with --version, or rerun with --npm to install zyrk@$NPM_VERSION."
  curl -fsSL "$base/$asset.sha256" -o "$work/$asset.sha256" ||
    die "Release $VERSION does not publish '$asset.sha256', so the download cannot be checked. Refusing to install it."

  expected="$(awk '{print $1; exit}' "$work/$asset.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$work/$asset" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$work/$asset" | awk '{print $1}')"
  else
    die "Neither sha256sum nor shasum is available to check the download. Refusing to install it."
  fi
  [ -n "$expected" ] && [ "$actual" = "$expected" ] ||
    die "SHA-256 mismatch for $asset. The download is corrupt or was altered; nothing was installed."
  ok "SHA-256 matches the release digest"

  step "Installing zyrk ${VERSION#v} with npm"
  npm install --global "$work/$asset" ||
    die "npm could not install $asset. Check npm's global directory permissions and retry."
fi

# --- verify ------------------------------------------------------------------

command -v zyrk >/dev/null 2>&1 ||
  die "zyrk was installed but is not on PATH. Add npm's global bin directory ($(npm prefix -g)/bin) to PATH."

printf '\n'
ok "zyrk $(zyrk --version 2>/dev/null || echo '(version unavailable)') is ready"
note "Run 'zyrk --help' to get started."
note "Update later by running this installer again."
printf '\n'
