#!/usr/bin/env bash
set -euo pipefail

# TabLoom one-command installer / updater / uninstaller
# Usage:
#   Inside repo:  ./install.sh [--open] [--with-acp] [--uninstall]
#   Fresh setup:  git clone https://github.com/jackerjay/tabloom.git ~/tabloom && ~/tabloom/install.sh --open

REPO_URL="${TABLOOM_REPO:-https://github.com/jackerjay/tabloom.git}"
TARGET_DIR="${TABLOOM_DIR:-$HOME/tabloom}"
BRANCH=""
WITH_ACP=0
UNINSTALL=0
OPEN_CHROME=0
NO_PULL=0
EXTRA_ORIGIN_ARGS=()

say() { printf '%s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }
die() { printf '[error] %s\n' "$*" >&2; exit 1; }

show_help() {
  cat <<'EOF'
TabLoom One-Command Installer

Usage:
  ./install.sh [options]

Options:
  --dir <path>         Install directory when run outside a checkout (default: ~/tabloom)
  --repo <url>         Git repository URL (default: https://github.com/jackerjay/tabloom.git)
  --branch <name>      Clone or checkout a specific branch
  --origin <id|url>    Additional Chrome extension ID or origin to allow (repeatable)
  --with-acp           Also install optional server npm dependencies (@zed-industries/codex-acp)
  --open               Reveal extension/ in Finder after setup for chrome://extensions Load Unpacked
  --no-pull            Skip automatic git pull when updating an existing clean checkout
  --uninstall          Remove LaunchAgent service and Native Messaging host registration
  -h, --help           Show this help message
EOF
}

require_arg() {
  local flag="$1"
  local val="${2:-}"
  [[ -n "$val" && "${val:0:1}" != "-" ]] || die "Option $flag requires a non-empty value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) require_arg "$1" "${2:-}"; TARGET_DIR="$2"; shift 2 ;;
    --dir=*) TARGET_DIR="${1#--dir=}"; [[ -n "$TARGET_DIR" ]] || die "--dir requires a value"; shift ;;
    --repo) require_arg "$1" "${2:-}"; REPO_URL="$2"; shift 2 ;;
    --repo=*) REPO_URL="${1#--repo=}"; [[ -n "$REPO_URL" ]] || die "--repo requires a value"; shift ;;
    --branch) require_arg "$1" "${2:-}"; BRANCH="$2"; shift 2 ;;
    --branch=*) BRANCH="${1#--branch=}"; [[ -n "$BRANCH" ]] || die "--branch requires a value"; shift ;;
    --origin) require_arg "$1" "${2:-}"; EXTRA_ORIGIN_ARGS+=("--origin" "$2"); shift 2 ;;
    --origin=*)
      _orig="${1#--origin=}"
      [[ -n "$_orig" ]] || die "--origin requires a value"
      EXTRA_ORIGIN_ARGS+=("--origin" "$_orig")
      shift
      ;;
    --with-acp) WITH_ACP=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --open) OPEN_CHROME=1; shift ;;
    --no-pull) NO_PULL=1; shift ;;
    -h|--help) show_help; exit 0 ;;
    *) die "Unknown option: $1 (run with --help for usage)" ;;
  esac
done

resolve_node() {
  local candidates=()
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [[ -x "$p" ]] && candidates+=("$p")
  done
  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    while IFS= read -r p; do
      candidates+=("$p")
    done < <(ls -1d "$HOME/.nvm/versions/node"/*/bin/node 2>/dev/null | sort -r)
  fi
  if [[ -d "$HOME/.volta/tools/image/node" ]]; then
    while IFS= read -r p; do
      candidates+=("$p")
    done < <(ls -1d "$HOME/.volta/tools/image/node"/*/bin/node 2>/dev/null | sort -r)
  fi
  for bin in "${candidates[@]}"; do
    [[ -x "$bin" ]] || continue
    local major
    major="$("$bin" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
    if [[ "$major" -ge 18 ]]; then
      printf '%s\n' "$bin"
      return 0
    fi
  done
  return 1
}

is_tabloom_root() {
  local dir="$1"
  [[ -f "$dir/extension/manifest.json" && -f "$dir/server/server.mjs" && -f "$dir/scripts/service.mjs" ]]
}

SCRIPT_ROOT=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if is_tabloom_root "$SCRIPT_DIR"; then
    SCRIPT_ROOT="$SCRIPT_DIR"
  fi
fi

ROOT_DIR=""
if [[ -n "$SCRIPT_ROOT" ]]; then
  ROOT_DIR="$SCRIPT_ROOT"
elif is_tabloom_root "$PWD"; then
  ROOT_DIR="$PWD"
elif is_tabloom_root "$TARGET_DIR"; then
  ROOT_DIR="$TARGET_DIR"
fi

NODE_BIN="$(resolve_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  die "Node.js 18+ not found. Install Node (e.g. brew install node) and retry."
fi
export PATH="$(dirname "$NODE_BIN"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

CLI_LINK="$HOME/.local/bin/tabloom"

if [[ "$UNINSTALL" -eq 1 ]]; then
  if [[ -z "$ROOT_DIR" ]]; then
    die "No TabLoom installation found (pass --dir <path> to specify)."
  fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    "$NODE_BIN" "$ROOT_DIR/scripts/service.mjs" uninstall
  fi
  if [[ -L "$CLI_LINK" ]]; then
    rm -f "$CLI_LINK"
    say "Removed CLI symlink: $CLI_LINK"
  fi
  say "Uninstall complete."
  exit 0
fi

if [[ -z "$ROOT_DIR" ]]; then
  command -v git >/dev/null 2>&1 || die "git is required when running outside an existing checkout."
  say "==> Cloning TabLoom into $TARGET_DIR ..."
  mkdir -p "$(dirname "$TARGET_DIR")"
  if [[ -n "$BRANCH" ]]; then
    git clone --depth 1 --branch "$BRANCH" -- "$REPO_URL" "$TARGET_DIR"
  else
    git clone --depth 1 -- "$REPO_URL" "$TARGET_DIR"
  fi
  ROOT_DIR="$(cd "$TARGET_DIR" && pwd)"
elif [[ "$NO_PULL" -eq 0 && -d "$ROOT_DIR/.git" ]]; then
  if [[ -n "$BRANCH" ]]; then
    git -C "$ROOT_DIR" checkout "$BRANCH" >/dev/null 2>&1 || warn "Could not switch branch to $BRANCH"
  fi
  if [[ -z "$(git -C "$ROOT_DIR" status --porcelain 2>/dev/null)" ]]; then
    say "==> Updating $ROOT_DIR ..."
    git -C "$ROOT_DIR" pull --ff-only >/dev/null 2>&1 || warn "Skipped git pull; continuing with current checkout."
  fi
fi

if [[ "$WITH_ACP" -eq 1 ]]; then
  if command -v npm >/dev/null 2>&1; then
    say "==> Installing optional server dependencies (server/node_modules)..."
    npm install --prefix "$ROOT_DIR/server" --no-audit --no-fund
  else
    warn "npm not found; skipping optional ACP dependency install (CLI/HTTP backends work without it)."
  fi
fi

say "==> Registering and starting local AI daemon (127.0.0.1:8787)..."
if [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ "${#EXTRA_ORIGIN_ARGS[@]}" -gt 0 ]]; then
    "$NODE_BIN" "$ROOT_DIR/scripts/service.mjs" install "${EXTRA_ORIGIN_ARGS[@]}"
  else
    "$NODE_BIN" "$ROOT_DIR/scripts/service.mjs" install
  fi
else
  warn "$(uname -s) detected; macOS LaunchAgent auto-start is skipped. Starting daemon in background..."
  nohup "$NODE_BIN" "$ROOT_DIR/server/server.mjs" >"$ROOT_DIR/server/server.log" 2>&1 &
fi

# Register terminal shortcut command `tabloom`
if [[ -f "$ROOT_DIR/scripts/tab-cli.mjs" ]] && mkdir -p "$HOME/.local/bin" 2>/dev/null; then
  if [[ ! -e "$CLI_LINK" || -L "$CLI_LINK" ]]; then
    chmod +x "$ROOT_DIR/scripts/tab-cli.mjs" 2>/dev/null || true
    ln -sfn "$ROOT_DIR/scripts/tab-cli.mjs" "$CLI_LINK"
    say "==> Registered CLI command: $CLI_LINK (e.g. tabloom summary / tabloom audit)"
  fi
fi

# Wait for local daemon /health
HEALTH_JSON=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  HEALTH_JSON="$(curl -fsS --max-time 1 http://127.0.0.1:8787/health 2>/dev/null || true)"
  [[ -n "$HEALTH_JSON" ]] && break
  sleep 0.5
done

say ""
if [[ -n "$HEALTH_JSON" ]]; then
  ACTIVE_INFO="$("$NODE_BIN" -e "try{const d=JSON.parse(process.argv[1]);console.log((d.backend?.cli||d.backend?.type||'heuristic')+' / '+(d.currentModel||'default'));}catch{console.log('online');}" "$HEALTH_JSON" 2>/dev/null || echo "online")"
  say "✅ TabLoom daemon installed and online (backend: $ACTIVE_INFO)"
else
  warn "Daemon is still starting or port 8787 is busy; check logs: $ROOT_DIR/server/server.log"
fi

EXT_DIR="$ROOT_DIR/extension"
say ""
say "Final step (Chrome / Brave / Edge extension setup, first time only):"
say "  1. Open chrome://extensions in your browser"
say "  2. Enable 'Developer mode' in the top-right corner"
say "  3. Click 'Load unpacked' and select: $EXT_DIR"
say ""

if [[ "$OPEN_CHROME" -eq 1 && "$(uname -s)" == "Darwin" ]]; then
  open -R "$EXT_DIR/manifest.json" 2>/dev/null || open "$EXT_DIR" 2>/dev/null || true
fi
