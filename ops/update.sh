#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
repo_dir="$(pwd)"
[[ -z "$(git -c safe.directory="$repo_dir" status --porcelain)" ]] || { echo 'Commit or stash local source changes before updating.'; exit 1; }
./ops/backup.sh
git -c safe.directory="$repo_dir" pull --ff-only
./ops/compose.sh build server runner-image
./ops/compose.sh up -d --wait server caddy
