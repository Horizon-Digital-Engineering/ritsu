#!/usr/bin/env bash
set -euo pipefail

# Installs LiteLLM into a project-local venv. LiteLLM is Python; we run it as
# a sidecar process and talk OpenAI-compatible HTTP to it on :4000.
# Only needed if any agent has dispatcher='litellm'.

PYTHON=${PYTHON:-python3}
VENV_DIR="${PWD}/.litellm-venv"

if [[ ! -d "${VENV_DIR}" ]]; then
  "${PYTHON}" -m venv "${VENV_DIR}"
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"
# Pin the versions Scorecard's Pinned-Dependencies check wants. Bump
# deliberately — these are sidecar deps, not part of the ritsu wire
# surface, so a bump is operator-driven rather than auto.
PIP_VERSION="25.3"
LITELLM_VERSION="1.81.5"

pip install --upgrade "pip==${PIP_VERSION}"
pip install "litellm[proxy]==${LITELLM_VERSION}"

echo
echo "LiteLLM installed. Start the proxy with:"
echo "  source ${VENV_DIR}/bin/activate"
echo "  litellm --port 4000 --config litellm-config.yaml"
