#!/usr/bin/env bash
# Pull latest, rebuild, restart. Run as your own user (with sudo).
#
# Idempotent + safe: aborts on uncommitted changes, only restarts if
# the build succeeded, prints status at the end.

set -euo pipefail

INSTALL_DIR="${RITSU_INSTALL_DIR:-/opt/ritsu}"
SERVICE_USER="${RITSU_USER:-ritsu}"
SERVICE_NAME="${RITSU_SERVICE:-ritsu.service}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '\033[2m  %s\033[0m\n' "$*"; }

bold "==> Pull"
sudo -u "${SERVICE_USER}" -H git -C "${INSTALL_DIR}" pull --ff-only
note "now at $(sudo -u "${SERVICE_USER}" -H git -C "${INSTALL_DIR}" rev-parse --short HEAD)"

bold "==> Install + build"
sudo -u "${SERVICE_USER}" -H bash -c "cd '${INSTALL_DIR}' && npm ci --no-audit --no-fund && npm run build"

bold "==> Refresh systemd unit (if changed)"
# install.sh's first run copied systemd/ritsu.service to /etc/systemd/system/.
# Re-sync here so changes to the unit (ReadWritePaths, env, etc.) take effect
# on update without manual intervention.
REPO_UNIT="${INSTALL_DIR}/systemd/${SERVICE_NAME}"
SYSTEM_UNIT="/etc/systemd/system/${SERVICE_NAME}"
if [[ -f "${REPO_UNIT}" ]] && ! sudo cmp -s "${REPO_UNIT}" "${SYSTEM_UNIT}" 2>/dev/null; then
  sudo install -o root -g root -m 644 "${REPO_UNIT}" "${SYSTEM_UNIT}"
  sudo systemctl daemon-reload
  note "refreshed ${SYSTEM_UNIT}"
else
  note "no change to systemd unit"
fi

bold "==> Refresh /usr/local/bin/ritsu shim"
# CLI ships in dist/cli.js. Re-install the shim every update so new
# subcommands / bug fixes land without re-running configure.sh.
if [[ -f "${INSTALL_DIR}/dist/cli.js" ]]; then
  sudo install -o root -g root -m 755 /dev/stdin /usr/local/bin/ritsu <<SHIM
#!/usr/bin/env bash
exec /usr/bin/node ${INSTALL_DIR}/dist/cli.js "\$@"
SHIM
  note "refreshed /usr/local/bin/ritsu"
else
  note "dist/cli.js missing — skipping (build failed?)"
fi

bold "==> Restart"
sudo systemctl restart "${SERVICE_NAME}"
sleep 1
sudo systemctl --no-pager status "${SERVICE_NAME}" | head -8

bold "==> Recent log"
sudo journalctl -u "${SERVICE_NAME}" --no-pager -n 15

bold "==> Done"
note "follow logs with:  sudo journalctl -u ${SERVICE_NAME} -f"
