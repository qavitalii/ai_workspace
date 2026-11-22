#!/bin/sh
set -eu

# The broker drops the bootstrap-only SETPCAP before loading any application code.
/usr/bin/setpriv --bounding-set=-setpcap -- \
    /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C \
    WORKSPACE_PACKAGE_CONCURRENCY="${WORKSPACE_PACKAGE_CONCURRENCY:-3}" \
    WORKSPACE_PACKAGE_RUN_BUDGET="${WORKSPACE_PACKAGE_RUN_BUDGET:-}" \
    WORKSPACE_PACKAGE_PRESET_BUDGET="${WORKSPACE_PACKAGE_PRESET_BUDGET:-}" \
    /usr/local/lib/workspace-install/sandbox \
    /usr/local/bin/node /app/dist/node/runner/package-broker.js </dev/null >/dev/null &
broker=$!

# Unsupported kernels leave ordinary runs usable without a root install path.
attempt=0
while [ "$attempt" -lt 30 ]; do
    if [ -f /run/workspace-packages/ready ]; then
        export WORKSPACE_SYSTEM_PACKAGES=1
        break
    fi
    if ! kill -0 "$broker" 2>/dev/null; then
        break
    fi
    /usr/bin/sleep 0.1
    attempt=$((attempt + 1))
done
if [ "${WORKSPACE_SYSTEM_PACKAGES:-}" != 1 ]; then
    kill "$broker" 2>/dev/null || true
fi

cd /workspace
exec /usr/bin/setpriv --reuid=1000 --regid=1000 --clear-groups \
    --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs -- \
    /usr/local/bin/node /app/dist/node/runner/main.js
