#!/usr/bin/env bash
# Local secret scan. Mirrors what .github/workflows/security.yml runs.
# Install gitleaks first: https://github.com/gitleaks/gitleaks/releases
#
# Optional pre-commit wiring (one-time, opt-in):
#   ln -s ../../scripts/scan-secrets.sh .git/hooks/pre-commit
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  cat >&2 <<'EOF'
gitleaks not installed. Install (Linux x64):
  curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
    | sudo tar -xz -C /usr/local/bin gitleaks
EOF
  exit 1
fi

# `gitleaks git --pre-commit --staged` for pre-commit hook context;
# `gitleaks git` for a full-repo audit when invoked standalone.
# Git sets PRE_COMMIT or the GIT_INDEX_FILE-relative env when running hooks;
# we treat either signal as authoritative instead of guessing from staged state.
if [[ -n "${PRE_COMMIT:-}" ]] || [[ "${GIT_HOOK_NAME:-}" == "pre-commit" ]] \
   || [[ "$(basename -- "${0}")" == "pre-commit" ]]; then
  exec gitleaks git --pre-commit --staged --redact --no-banner
else
  exec gitleaks git --redact --no-banner
fi
