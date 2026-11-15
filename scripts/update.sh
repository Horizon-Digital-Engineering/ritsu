#!/usr/bin/env bash
# Pull latest, rebuild, restart. Run as your own user (with sudo).
#
# Idempotent + safe: aborts on uncommitted changes, only restarts if
# the build succeeded, then waits until `ritsu health` answers.
#
# Usage (update-ritsu is the installed shim for this script):
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
sudo -u "${SERVICE_USER}" -H bash -c "cd '${INSTALL_DIR}' && ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund && npm run build"

bold "==> Backup + rehearse"
# A fresh encrypted backup of the running database, then the NEW build's
# migrations run on a copy of it. Either failing stops here, before anything
# the service uses changes. The CLI opens the live file read-only.
CLI=(sudo /usr/bin/node "${INSTALL_DIR}/dist/cli.js")
# grep finds nothing when the key is unset, and pipefail would end the script.
DB_PATH="$(sudo grep -E '^DB_PATH=' /etc/ritsu/env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' "' || true)"
DB_PATH="${DB_PATH:-${INSTALL_DIR}/data/ritsu.db}"
if sudo test -f "${DB_PATH}"; then
  if ! "${CLI[@]}" backup; then
    echo "backup failed — the running service is untouched." >&2
    echo "If no backup password is set yet:  sudo ritsu backup set-password" >&2
    exit 1
  fi
  if ! "${CLI[@]}" backup rehearse latest; then
    echo "the new build's migrations failed on a copy of the backup — the running service is untouched." >&2
    exit 1
  fi
else
  note "no database yet — nothing to back up"
fi

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
# Both shims are real files in scripts/, copied with install: a heredoc piped
# into sudo install has no stdin to read and aborts the update before the restart.
sudo install -o root -g root -m 755 "${INSTALL_DIR}/scripts/ritsu" /usr/local/bin/ritsu
note "refreshed /usr/local/bin/ritsu"

bold "==> Refresh /usr/local/bin/update-ritsu"
sudo install -o root -g root -m 755 "${INSTALL_DIR}/scripts/update-ritsu" /usr/local/bin/update-ritsu
note "refreshed /usr/local/bin/update-ritsu"

bold "==> Restart"
started="$(date '+%Y-%m-%d %H:%M:%S')"
sudo systemctl restart "${SERVICE_NAME}"
log_since_restart() { sudo journalctl -u "${SERVICE_NAME}" --no-pager --since "${started}" -n "$1"; }

bold "==> Health"
# systemd calls the unit started before ritsu listens, and a boot whose
# migrations change the schema writes a pre-upgrade backup first.
rc=0
"${CLI[@]}" health --wait 600 || rc=$?
case "${rc}" in
  0)
    bold "==> Recent log"
    log_since_restart 15
    ;;
  1)
    log_since_restart 40
    echo "ritsu is up but a part is failing — left running; the log since the restart is above." >&2
    exit 1
    ;;
  3)
    sudo systemctl stop "${SERVICE_NAME}"
    log_since_restart 40
    echo "ritsu did not answer within 600 s — stopped it; the log since the restart is above." >&2
    exit 1
    ;;
  *)
    log_since_restart 40
    echo "the health check could not run (exit ${rc}) — ritsu left running." >&2
    exit 1
    ;;
esac

bold "==> Done"
note "follow logs with:  sudo journalctl -u ${SERVICE_NAME} -f"
