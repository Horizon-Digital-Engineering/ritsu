#!/usr/bin/env bash
# Bootstrap ritsu on a remote Linux+systemd host. Run from your laptop.
#
# Usage:
#   bash bootstrap-remote.sh --host <hostname-or-ip> --user <ssh-user> [--env <path>]
#
# Required:
#   --host  SSH target (hostname, IP, or .ssh/config alias)
#   --user  SSH user with sudo on the target
#
# Optional:
#   --env                Local env file to ship to /etc/ritsu/env.
#                        Supports a __TAILSCALE_IP__ placeholder — if present,
#                        the script runs `tailscale ip -4` on the remote and
#                        substitutes the result.
#   --repo               Override the git URL to clone (default: this repo's).
#   --setup-deploy-key   Set up an SSH deploy key on the remote BEFORE install,
#                        so the remote can git clone/pull the private repo.
#                        Requires `gh` authenticated on the LOCAL machine
#                        (yours) with write access to the repo. Idempotent.
#                        Without this flag, you must arrange remote git auth
#                        some other way (gh login on the remote, existing
#                        deploy key, etc).
#
# What it does on the remote:
#   1. clones the ritsu repo to /tmp (uses the remote's gh CLI auth)
#   2. runs scripts/install.sh — creates the ritsu user, builds, installs
#      and starts the systemd service
#   3. if --env supplied: substitutes placeholders + writes /etc/ritsu/env
#   4. installs /usr/local/bin/update-ritsu so `ssh <host> update-ritsu` works
#   5. restarts ritsu and smoke-tests the health endpoints
#
# After this, one interactive step on the remote (claude device-code login):
#   ssh <host>
#   which claude || sudo npm install -g @anthropic-ai/claude-code
#   claude setup-token   (on any machine; save the token under API Keys in the admin UI)
#
# Re-run safely: every step is idempotent.

set -euo pipefail

REPO_URL_DEFAULT="https://github.com/Horizon-Digital-Engineering/ritsu.git"

HOST=""
SSH_USER=""
ENV_PATH=""
REPO_URL="${REPO_URL_DEFAULT}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '\033[2m  %s\033[0m\n' "$*"; }
fail() { printf '\033[31m  ✕ %s\033[0m\n' "$*" >&2; exit 1; }
usage() { sed -n '2,32p' "$0" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)  HOST="${2-}";     shift 2 ;;
    --user)  SSH_USER="${2-}"; shift 2 ;;
    --env)   ENV_PATH="${2-}"; shift 2 ;;
    --repo)  REPO_URL="${2-}"; shift 2 ;;
    -h|--help) usage ;;
    *) fail "unknown arg: $1 (run with --help)" ;;
  esac
done

[[ -n "${HOST}"     ]] || fail "--host required"
[[ -n "${SSH_USER}" ]] || fail "--user required"
if [[ -n "${ENV_PATH}" ]]; then
  [[ -f "${ENV_PATH}" ]] || fail "env file not found: ${ENV_PATH}"
fi

bold "==> Preflight: can we reach ${SSH_USER}@${HOST}?"
ssh -o BatchMode=yes -o ConnectTimeout=5 "${SSH_USER}@${HOST}" 'echo ok' >/dev/null 2>&1 \
  || fail "ssh ${SSH_USER}@${HOST} failed"
note "ok"

bold "==> Run install.sh on ${HOST}"
# scp install.sh from alongside this script — sidesteps the need for the
# remote's deploy user to have GitHub auth. install.sh itself
# will then clone /opt/ritsu as the ritsu user (which has a deploy key or
# other arrangement). The repo URL is passed via env var.
INSTALL_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh"
[[ -f "${INSTALL_SH}" ]] || fail "install.sh not found alongside bootstrap-remote.sh"
scp -q "${INSTALL_SH}" "${SSH_USER}@${HOST}:/tmp/ritsu-install.sh"
ssh "${SSH_USER}@${HOST}" "RITSU_REPO_URL='${REPO_URL}' sudo -E bash /tmp/ritsu-install.sh"
ssh "${SSH_USER}@${HOST}" 'rm -f /tmp/ritsu-install.sh'
note "install.sh completed"

if [[ -n "${ENV_PATH}" ]]; then
  bold "==> Build env file"
  ENV_RENDERED="$(mktemp)"
  cp "${ENV_PATH}" "${ENV_RENDERED}"
  if grep -q '__TAILSCALE_IP__' "${ENV_RENDERED}"; then
    note "env references __TAILSCALE_IP__ — discovering on remote"
    TS_IP="$(ssh "${SSH_USER}@${HOST}" 'tailscale ip -4 2>/dev/null | head -1')"
    [[ -n "${TS_IP}" ]] || fail "tailscale ip -4 returned nothing on ${HOST}"
    note "tailscale ip: ${TS_IP}"
    sed -i.bak "s|__TAILSCALE_IP__|${TS_IP}|g" "${ENV_RENDERED}"
    rm -f "${ENV_RENDERED}.bak"
  fi

  bold "==> Push env file to /etc/ritsu/env"
  scp -q "${ENV_RENDERED}" "${SSH_USER}@${HOST}:/tmp/ritsu-env.in" >/dev/null
  ssh "${SSH_USER}@${HOST}" bash -s <<'EOF'
set -euo pipefail
sudo install -o ritsu -g ritsu -m 600 /tmp/ritsu-env.in /etc/ritsu/env
rm -f /tmp/ritsu-env.in
EOF
  rm -f "${ENV_RENDERED}"
  note "/etc/ritsu/env written"
fi

bold "==> Install update-ritsu shortcut"
ssh "${SSH_USER}@${HOST}" bash -s <<'EOF'
set -euo pipefail
sudo install -o root -g root -m 755 /dev/stdin /usr/local/bin/update-ritsu <<'SHIM'
#!/usr/bin/env bash
# Pull latest ritsu, rebuild, restart. Wraps the canonical script.
exec sudo bash /opt/ritsu/scripts/update.sh "$@"
SHIM
EOF
note "/usr/local/bin/update-ritsu installed"

bold "==> Restart + smoke test"
ssh "${SSH_USER}@${HOST}" bash -s <<'EOF'
set -euo pipefail
sudo systemctl restart ritsu
sleep 1
sudo systemctl --no-pager status ritsu | head -8
PORT="$(grep -E '^PORT=' /etc/ritsu/env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d ' ')"
ADMIN_PORT="$(grep -E '^ADMIN_PORT=' /etc/ritsu/env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d ' ')"
MCP_HOST="$(grep -E '^MCP_HOST=' /etc/ritsu/env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d ' ')"
echo
echo "--- admin /healthz (127.0.0.1:${ADMIN_PORT:-7334}) ---"
curl -s "http://127.0.0.1:${ADMIN_PORT:-7334}/healthz" || true
echo
echo "--- MCP /healthz (${MCP_HOST:-127.0.0.1}:${PORT:-7333}) ---"
curl -s "http://${MCP_HOST:-127.0.0.1}:${PORT:-7333}/healthz" || true
echo
EOF

bold "==> Done"
note "one-time interactive step on ${HOST}:"
note "  ssh ${HOST}"
note "  which claude || sudo npm install -g @anthropic-ai/claude-code"
note "  claude setup-token   # then save it under API Keys in the admin UI"
note ""
note "future updates from anywhere with SSH:"
note "  ssh ${HOST} update-ritsu"
note ""
note "manage (admin UI, no auth — tunnel from your laptop):"
note "  ssh -L \${ADMIN_PORT:-7334}:localhost:\${ADMIN_PORT:-7334} ${HOST}"
