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
pip install --upgrade pip
pip install 'litellm[proxy]'

echo
echo "LiteLLM installed. Start the proxy with:"
echo "  source ${VENV_DIR}/bin/activate"
echo "  litellm --port 4000 --config litellm-config.yaml"
