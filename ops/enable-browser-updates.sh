#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
repo="$(pwd -P)"
if [[ "$(uname)" != Linux || "$EUID" != 0 || ! -d /run/systemd/system ||
      ! -f .install-mode || "$(cat .install-mode)" != --server ]]; then
  echo 'Browser updates require a root-managed Linux Workspace server with systemd.' >&2
  exit 1
fi
if [[ ! "$repo" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
  echo 'The Workspace installation path contains characters unsupported by browser updates.' >&2
  exit 1
fi
git -c safe.directory="$repo" remote get-url origin >/dev/null

# Protect host-written status and recovery metadata from the writable request mount.
for directory in .update-state .update-state/status .update-state/requests; do
  [[ ! -L "$directory" ]] || { echo "Unexpected symbolic link: $directory" >&2; exit 1; }
  install -d -m 0700 -o root -g root "$directory"
done

# Use the same Compose files as the running server, including connected folders.
# Browser maintenance must never silently drop a custom Compose override.
server="$(./ops/compose.sh ps -q server)"
[[ -n "$server" ]] || { echo 'Start Workspace before enabling browser updates.' >&2; exit 1; }
files="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$server")"
case "$files" in
  "$repo/compose.yaml") compose_file=compose.yaml ;;
  "$repo/compose.yaml,$repo/compose.folders.yaml") compose_file=compose.yaml:compose.folders.yaml ;;
  *) echo 'Browser updates support the standard server configuration and the connected-folders override.' >&2; exit 1 ;;
esac
mounts="$(docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "$server")"
for mount in /run/workspace-updates/status /run/workspace-updates/requests; do
  if ! grep -Fxq "$mount" <<< "$mounts"; then
    echo 'Update and restart Workspace before enabling browser updates.' >&2
    exit 1
  fi
done

cat > /etc/systemd/system/ai-workspace-updates.service <<UNIT
[Unit]
Description=AI Workspace browser updates
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$repo
Environment=COMPOSE_FILE=$compose_file
ExecStart=/usr/bin/python3 -I $repo/ops/browser-updates.py
TimeoutStartSec=60min
UMask=0077
UNIT
cat > /etc/systemd/system/ai-workspace-updates.timer <<'UNIT'
[Unit]
Description=Check for AI Workspace updates and process update requests

[Timer]
OnActiveSec=1s
OnUnitInactiveSec=10s
AccuracySec=1s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now ai-workspace-updates.timer
echo 'Browser updates enabled. Open Settings → Updates in Workspace.'
