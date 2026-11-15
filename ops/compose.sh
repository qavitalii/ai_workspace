#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
if [[ -f .install-mode && "$(cat .install-mode)" == --local ]]; then exec docker compose -f compose.yaml -f compose.local.yaml "$@"; else exec docker compose "$@"; fi
