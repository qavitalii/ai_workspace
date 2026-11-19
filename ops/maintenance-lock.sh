# Browser updates hold this same host lock. Its presence means the host
# updater was configured, so standard local installs need no flock utility.
if [[ -f .update-state/maintenance.lock && "${WORKSPACE_MAINTENANCE_LOCKED:-}" != 1 ]]; then
  exec 9>>.update-state/maintenance.lock
  flock --nonblock 9 || { echo 'Workspace maintenance is already running. Try again shortly.' >&2; exit 1; }
  export WORKSPACE_MAINTENANCE_LOCKED=1
fi
