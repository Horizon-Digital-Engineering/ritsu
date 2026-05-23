#!/usr/bin/env bash
# ritsu installer for a Linux host with Node 20+ and systemd.
#
# Idempotent: safe to re-run. Will create the user/dirs/service on first run,
# update the code + restart on subsequent runs.
#
# What it does:
#   1. Creates the `ritsu` system user (skipped if it exists)
#   2. Clones / pulls https://github.com/Horizon-Digital-Engineering/ritsu
#      into /opt/ritsu (uses the *invoking user's* gh CLI auth for the first
#      clone, since the repo is private)
#   3. Runs `npm ci && npm run build` as the ritsu user
#   4. If /etc/ritsu/env doesn't exist, writes a template (does NOT overwrite)
#   5. Installs systemd/ritsu.service and enables it
#   6. (Re)starts the service and prints status
#
# Run as your own user with sudo available:
#   curl -L https://raw.githubusercontent.com/Horizon-Digital-Engineering/ritsu/main/scripts/install.sh | bash
# or from a clone:
#   bash scripts/install.sh
#
# Interactive bits (do these BEFORE running, or the install completes but the
# service won't be able to actually talk to Claude):
#   - Install Claude Code CLI globally:   sudo npm install -g @anthropic-ai/claude-code
#   - Auth as the ritsu user:             sudo -u ritsu -H claude login
# The script will print a reminder if it detects the credentials are missing.

set -euo pipefail

REPO_URL="${RITSU_REPO_URL:-https://github.com/Horizon-Digital-Engineering/ritsu.git}"
INSTALL_DIR="${RITSU_INSTALL_DIR:-/opt/ritsu}"
ENV_DIR="${RITSU_ENV_DIR:-/etc/ritsu}"
ENV_FILE="${ENV_DIR}/env"
SERVICE_USER="${RITSU_USER:-ritsu}"
SERVICE_NAME="${RITSU_SERVICE:-ritsu.service}"
CLAUDE_HOME="/home/${SERVICE_USER}/.claude"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
note()  { printf '\033[2m  %s\033[0m\n' "$*"; }
warn()  { printf '\033[33m  ! %s\033[0m\n' "$*"; }
fail()  { printf '\033[31m  ✕ %s\033[0m\n' "$*"; exit 1; }

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: $cmd"
}

bold "==> Preflight"
require_cmd sudo
require_cmd node
require_cmd npm
require_cmd systemctl
node_major="$(node --version | sed 's/v\([0-9]*\).*/\1/')"
[[ "${node_major}" -ge 20 ]] || fail "Node >=20 required; found $(node --version)"
note "node $(node --version), systemctl present"

bold "==> User: ${SERVICE_USER}"
if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  note "exists (uid $(id -u "${SERVICE_USER}"))"
else
  sudo useradd --system --create-home --shell /bin/bash --user-group "${SERVICE_USER}"
  note "created"
fi

bold "==> Directories"
sudo install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 750 "${INSTALL_DIR}"
sudo install -d -o root -g root -m 755 "${ENV_DIR}"
note "${INSTALL_DIR} (owner: ${SERVICE_USER})"
note "${ENV_DIR} (owner: root)"

bold "==> Source code"
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  note "existing checkout — pulling"
  sudo -u "${SERVICE_USER}" -H git -C "${INSTALL_DIR}" pull --ff-only
else
  note "cloning fresh"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    tmp="$(mktemp -d)"
    gh repo clone "${REPO_URL%.git}" "${tmp}/ritsu" >/dev/null
    sudo cp -a "${tmp}/ritsu/." "${INSTALL_DIR}/"
    sudo chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"
    rm -rf "${tmp}"
  else
    warn "no gh CLI / not auth'd — falling back to git clone (will prompt for creds if the repo is private)"
    sudo -u "${SERVICE_USER}" -H git clone "${REPO_URL}" "${INSTALL_DIR}"
  fi
fi

bold "==> Install + build"
sudo -u "${SERVICE_USER}" -H bash -c "cd '${INSTALL_DIR}' && npm ci --no-audit --no-fund && npm run build"

bold "==> Env file"
if [[ -f "${ENV_FILE}" ]]; then
  note "${ENV_FILE} exists — not overwriting"
else
  warn "${ENV_FILE} not present — writing a default template (edit before next restart!)"
  sudo install -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 600 /dev/stdin "${ENV_FILE}" <<EOF
# ritsu prod env. See ${INSTALL_DIR}/.env.example for all options.
# NOTE: dotenv does not strip inline comments — keep comments on their own line.

PORT=7333
# bind narrow; flip to a Tailscale/private IP for tailnet access
MCP_HOST=127.0.0.1
# prod: fail closed even if the token table is empty
MCP_REQUIRE_AUTH=on

ADMIN_PORT=7334
# admin has no auth — DO NOT expose
ADMIN_HOST=127.0.0.1

DB_PATH=${INSTALL_DIR}/data/ritsu.db
LOG_LEVEL=info
EOF
fi

bold "==> Systemd unit"
sudo install -o root -g root -m 644 "${INSTALL_DIR}/systemd/${SERVICE_NAME}" "/etc/systemd/system/${SERVICE_NAME}"
sudo systemctl daemon-reload
note "/etc/systemd/system/${SERVICE_NAME}"

bold "==> Claude CLI session check"
if [[ ! -f "${CLAUDE_HOME}/.credentials.json" ]]; then
  warn "${CLAUDE_HOME}/.credentials.json missing"
  warn "the claude-direct dispatcher will fail at first call until you run:"
  warn "  sudo npm install -g @anthropic-ai/claude-code   # if not already"
  warn "  sudo -u ${SERVICE_USER} -H claude login"
else
  note "credentials present"
fi

bold "==> Start"
sudo systemctl enable "${SERVICE_NAME}" >/dev/null
sudo systemctl restart "${SERVICE_NAME}"
sleep 1
sudo systemctl --no-pager status "${SERVICE_NAME}" | head -10

bold "==> Smoke test"
port="$(grep -E '^PORT=' "${ENV_FILE}" | tail -1 | cut -d= -f2 | tr -d ' "')"
admin_port="$(grep -E '^ADMIN_PORT=' "${ENV_FILE}" | tail -1 | cut -d= -f2 | tr -d ' "')"
mcp_host="$(grep -E '^MCP_HOST=' "${ENV_FILE}" | tail -1 | cut -d= -f2 | tr -d ' "')"
note "MCP healthz:    $(curl -s "http://${mcp_host:-127.0.0.1}:${port:-7333}/healthz" || echo failed)"
note "admin healthz:  $(curl -s "http://127.0.0.1:${admin_port:-7334}/healthz" || echo failed)"

bold "==> Done"
note "logs:    sudo journalctl -u ${SERVICE_NAME} -f"
note "env:     sudo \$EDITOR ${ENV_FILE}  &&  sudo systemctl restart ${SERVICE_NAME}"
note "update:  bash ${INSTALL_DIR}/scripts/update.sh"
note "admin:   ssh-tunnel localhost:${admin_port:-7334} then open http://localhost:${admin_port:-7334}/admin"
