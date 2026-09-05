#!/usr/bin/env bash
# ritsu installer for a Linux host with Node 20+ and systemd.
#
# Idempotent: safe to re-run. Will create the user/dirs/service on first run,
# update the code + restart on subsequent runs.
#
# What it does:
#   1. Creates the `ritsu` system user (skipped if it exists)
#   2. Clones / pulls https://github.com/Horizon-Digital-Engineering/ritsu
#      into /opt/ritsu
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
# After it finishes, save a subscription token in the admin UI (API Keys) —
# generate one anywhere with `claude setup-token`. Agents cannot dispatch
# until one is stored; the installer prints a reminder.

set -euo pipefail

REPO_URL="${RITSU_REPO_URL:-https://github.com/Horizon-Digital-Engineering/ritsu.git}"
INSTALL_DIR="${RITSU_INSTALL_DIR:-/opt/ritsu}"
ENV_DIR="${RITSU_ENV_DIR:-/etc/ritsu}"
ENV_FILE="${ENV_DIR}/env"
SERVICE_USER="${RITSU_USER:-ritsu}"
SERVICE_NAME="${RITSU_SERVICE:-ritsu.service}"

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
# The .git probe must run WITH privileges: the install dir is 750 ritsu:ritsu,
# so an unprivileged test can't traverse it and reports "no repo" for a
# perfectly good checkout — sending a reinstall down the clone path to die on
# the non-empty directory.
if sudo test -d "${INSTALL_DIR}/.git"; then
  note "existing checkout — syncing to origin/main"
  sudo -u "${SERVICE_USER}" -H git -C "${INSTALL_DIR}" fetch origin --prune
  sudo -u "${SERVICE_USER}" -H git -C "${INSTALL_DIR}" reset --hard origin/main
elif sudo find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q .; then
  echo "ERROR: ${INSTALL_DIR} is non-empty but not a git checkout." >&2
  echo "Inspect it (sudo ls -la ${INSTALL_DIR}) — move data aside or remove it, then re-run." >&2
  exit 1
else
  note "cloning fresh"
  sudo -u "${SERVICE_USER}" -H git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

bold "==> Install + build"
sudo -u "${SERVICE_USER}" -H bash -c "cd '${INSTALL_DIR}' && npm ci --no-audit --no-fund && npm run build"

bold "==> Master key"
# Secrets are AES-256-GCM encrypted at rest and unwritable without this. Kept
# out of ${INSTALL_DIR} on purpose: beside the database, one filesystem
# snapshot would carry both the ciphertext and the key that opens it.
KEY_FILE="${ENV_DIR}/master-key"
if [[ -f "${KEY_FILE}" ]]; then
  note "${KEY_FILE} exists — leaving it alone"
else
  sudo sh -c "umask 077; openssl rand -base64 32 > '${KEY_FILE}'"
  sudo chown "${SERVICE_USER}:${SERVICE_USER}" "${KEY_FILE}"
  sudo chmod 0600 "${KEY_FILE}"
  warn "generated ${KEY_FILE} — BACK IT UP NOW"
  warn "it is deliberately excluded from database backups; without it every stored secret is unrecoverable"
fi

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

bold "==> Subscription credential"
# Direct-runtime agents authenticate with a long-lived subscription token.
# It is account-scoped rather than machine-scoped, so generate it anywhere and
# paste it into the admin UI — no interactive login on each host.
note "generate:  claude setup-token       (on any machine, needs a subscription)"
note "then save it under API Keys in the admin UI"
note "agents cannot dispatch until one is stored" 

bold "==> Start"
sudo systemctl enable "${SERVICE_NAME}" >/dev/null
sudo systemctl restart "${SERVICE_NAME}"
sleep 1
sudo systemctl --no-pager status "${SERVICE_NAME}" | head -10

bold "==> Smoke test"
# The env file is 0600 and owned by the service user, so read it as root —
# otherwise every install ends with a permission error that looks like failure.
env_val() { sudo grep -E "^$1=" "${ENV_FILE}" | tail -1 | cut -d= -f2 | tr -d ' "'; }
port="$(env_val PORT)"
admin_port="$(env_val ADMIN_PORT)"
mcp_host="$(env_val MCP_HOST)"
note "MCP healthz:    $(curl -s "http://${mcp_host:-127.0.0.1}:${port:-7333}/healthz" || echo failed)"
note "admin healthz:  $(curl -s "http://127.0.0.1:${admin_port:-7334}/healthz" || echo failed)"

bold "==> Done"
note "logs:    sudo journalctl -u ${SERVICE_NAME} -f"
note "env:     sudo \$EDITOR ${ENV_FILE}  &&  sudo systemctl restart ${SERVICE_NAME}"
note "update:  git pull && bash scripts/install.sh   (from your clone — this script is the update path)"
note "admin:   ssh-tunnel localhost:${admin_port:-7334} then open http://localhost:${admin_port:-7334}/admin"
