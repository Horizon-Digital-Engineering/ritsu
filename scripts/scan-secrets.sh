#!/usr/bin/env bash
# Local secret scan. Mirrors what .github/workflows/security.yml runs.
# Install gitleaks first: https://github.com/gitleaks/gitleaks/releases
#
# Optional pre-commit wiring (one-time, opt-in):
#   ln -s ../../scripts/scan-secrets.sh .git/hooks/pre-commit
#
set -eo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks not installed; skipping. Install:" >&2
  echo "  curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz | sudo tar -xz -C /usr/local/bin gitleaks" >&2
  exit 0
fi

# When run as a pre-commit hook, scan only the staged diff (fast).
# When run standalone, scan the full repo history (matches CI).
if [[ -n "${GIT_INDEX_FILE:-}" ]] || git diff --cached --name-only | grep -q .; then
  exec gitleaks protect --staged --redact --no-banner
else
  exec gitleaks detect --redact --no-banner
fi
