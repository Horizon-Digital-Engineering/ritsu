#!/usr/bin/env bash
# Local secret scan. Same gitleaks invocation CI runs against the full repo.
# For a pre-commit hook, prefer gitleaks's own integration:
#   gitleaks install --pre-commit
# (or symlink this script if you'd rather; gitleaks does the right thing when
# invoked from a git hook with no flags too.)
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks not installed: https://github.com/gitleaks/gitleaks/releases" >&2
  exit 1
fi

exec gitleaks git --redact --no-banner
