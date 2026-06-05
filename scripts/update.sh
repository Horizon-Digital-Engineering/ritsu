#!/usr/bin/env bash
# Pull latest, rebuild, restart. Run as your own user (with sudo).
#
# Idempotent + safe: aborts on uncommitted changes, only restarts if
# the build succeeded, prints status at the end.
#
# Usage:
#   update-ritsu                       # deploy origin/main (default)
#   update-ritsu --branch feat/x       # deploy origin/feat/x (test a PR branch)
#   update-ritsu -b feat/x             # short form
#   update-ritsu --branch feat/x --force   # discard local changes on the box first
#
# Branch mode hard-syncs the install to origin/<branch> (the deploy box
# is a mirror of origin, never a place to edit). Switching back is just
# `update-ritsu` with no flag — it returns to origin/main.

set -euo pipefail

INSTALL_DIR="${RITSU_INSTALL_DIR:-/opt/ritsu}"
SERVICE_USER="${RITSU_USER:-ritsu}"
SERVICE_NAME="${RITSU_SERVICE:-ritsu.service}"

BRANCH="main"
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -b|--branch) BRANCH="${2:?--branch needs a name}"; shift 2 ;;
    --force)     FORCE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '\033[2m  %s\033[0m\n' "$*"; }

as_svc() { sudo -u "${SERVICE_USER}" -H git -C "${INSTALL_DIR}" "$@"; }

bold "==> Sync to origin/${BRANCH}"
# Only *tracked* modifications block a deploy. The data dir holds untracked
# runtime files (the live DB, the .admin-token) that legitimately live in
# the working tree and must NEVER be touched — so `--untracked-files=no`,
# and crucially no `git clean` anywhere (it would delete the admin token).
if [[ -n "$(as_svc status --porcelain --untracked-files=no)" ]]; then
  if [[ "${FORCE}" -eq 1 ]]; then
    note "tracked files modified — --force given, discarding those edits"
    as_svc reset --hard
  else
    echo "tracked files at ${INSTALL_DIR} are modified — aborting." >&2
    echo "commit/stash on the box, or re-run with --force to discard them." >&2
    echo "(untracked runtime files like data/.admin-token are ignored + preserved.)" >&2
    exit 1
  fi
fi
as_svc fetch origin --prune
# checkout -B creates-or-moves the local branch onto origin/<branch> and
# checks it out; the follow-up reset --hard guarantees an exact mirror of
# tracked files. Untracked runtime files (DB, token) are left in place.
as_svc checkout -B "${BRANCH}" "origin/${BRANCH}"
as_svc reset --hard "origin/${BRANCH}"
note "now at ${BRANCH} @ $(as_svc rev-parse --short HEAD)"

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
