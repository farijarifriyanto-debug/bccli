#!/usr/bin/env bash
# BCCLI installer — https://github.com/farijarifriyanto-debug/bccli
# Installs @botconnector/bccli@next for the current user (no sudo).
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/farijarifriyanto-debug/bccli/main/install.sh | bash
# Flags (when run from a checkout): --version vX.Y.Z, --prefix DIR, --no-modify-path, --help
set -euo pipefail

BCCLI_VERSION="${BCCLI_VERSION:-next}"          # npm dist-tag or exact version
NODE_VERSION="v24.21.0"                         # portable Node used when system Node is missing/old
MIN_NODE_MAJOR=22
INSTALL_PREFIX="${BCCLI_PREFIX:-$HOME/.local}"
MODIFY_PATH=1
REPO_RAW="${BCCLI_REPO_RAW:-https://raw.githubusercontent.com/farijarifriyanto-debug/bccli/main}"

log()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version)         BCCLI_VERSION="$2"; shift 2 ;;
    --prefix)          INSTALL_PREFIX="$2"; shift 2 ;;
    --no-modify-path)  MODIFY_PATH=0; shift ;;
    -h|--help)         sed -n '2,6p' "$0"; exit 0 ;;
    *)                 die "Unknown flag: $1" ;;
  esac
done

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux|Darwin) ;;
  MINGW*|MSYS*|CYGWIN*)
    if command -v node >/dev/null 2>&1; then
      log "Windows shell detected — installing with your existing Node.js ..."
      npm install -g "@botconnector/bccli@$BCCLI_VERSION"
      bccli --version || true
      log "Done. Run 'bccli login' to store your BotConnector Cloud API key."
      exit 0
    fi
    die "On Windows without Node.js, use PowerShell: irm https://raw.githubusercontent.com/farijarifriyanto-debug/bccli/main/install.ps1 | iex" ;;
  *) die "Unsupported OS: $OS" ;;
esac
case "$ARCH" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  arm64|aarch64) NODE_ARCH="arm64" ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge "$MIN_NODE_MAJOR" ]
}

fetch() { # fetch URL DEST
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "Need curl or wget to download files."; fi
}

ensure_node() {
  if node_ok; then
    log "Using system Node.js $(node --version)"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    warn "System Node.js $(node --version) is older than $MIN_NODE_MAJOR — installing a portable Node $NODE_VERSION for BCCLI."
  else
    log "Node.js not found — installing portable Node $NODE_VERSION for BCCLI (no sudo, no system changes)."
  fi
  local node_dir="$HOME/.bccli/node/$NODE_VERSION"
  local tarball
  if [ "$OS" = "Darwin" ]; then tarball="node-$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"; else tarball="node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"; fi
  local tmp; tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  log "Downloading $tarball from nodejs.org ..."
  fetch "https://nodejs.org/dist/$NODE_VERSION/$tarball" "$tmp/$tarball"
  if [ "$OS" = "Linux" ] && command -v sha256sum >/dev/null 2>&1; then
    fetch "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
    (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -) || die "Checksum mismatch for $tarball — aborting."
  fi
  mkdir -p "$node_dir"
  tar -xJf "$tmp/$tarball" -C "$node_dir" --strip-components=1 2>/dev/null \
    || tar -xzf "$tmp/$tarball" -C "$node_dir" --strip-components=1
  export PATH="$node_dir/bin:$PATH"
  node_ok || die "Portable Node.js install failed."
  log "Portable Node.js $(node --version) ready at $node_dir"
}

add_path_line() { # add_path_line RC_FILE LINE
  local rc="$1" line="$2"
  [ -f "$rc" ] || return 0
  grep -qsF "$line" "$rc" || printf '\n# bccli\n%s\n' "$line" >>"$rc"
}

main() {
  ensure_node
  log "Installing @botconnector/bccli@$BCCLI_VERSION into $INSTALL_PREFIX (user install, no sudo) ..."
  mkdir -p "$INSTALL_PREFIX"
  npm install -g "@botconnector/bccli@$BCCLI_VERSION" --prefix "$INSTALL_PREFIX"
  local bin_dir="$INSTALL_PREFIX/bin"
  if [ ! -x "$bin_dir/bccli" ]; then
    # some npm layouts use different bin dir; locate it
    bin_dir="$(dirname "$(command -v bccli || true)")"
  fi
  [ -x "$bin_dir/bccli" ] || die "Install finished but bccli was not found. Check npm output above."

  if [ "$MODIFY_PATH" = 1 ] && ! printf ':%s:' "$PATH" | grep -qs ":$bin_dir:"; then
    warn "$bin_dir is not on your PATH. Adding it to ~/.profile, ~/.bashrc and ~/.zshrc (look for '# bccli')."
    add_path_line "$HOME/.profile"   "export PATH=\"$bin_dir:\$PATH\""
    add_path_line "$HOME/.bashrc"    "export PATH=\"$bin_dir:\$PATH\""
    add_path_line "$HOME/.zshrc"     "export PATH=\"$bin_dir:\$PATH\""
    export PATH="$bin_dir:$PATH"
  fi

  log ""
  log "BCCLI $("$bin_dir/bccli" --version) installed."
  log ""
  log "Next steps:"
  log "  bccli login          # store your BotConnector Cloud API key"
  log "  cd your-project && bccli"
  log ""
  log "Docs: https://botconnector.id/id/download"
}

main
