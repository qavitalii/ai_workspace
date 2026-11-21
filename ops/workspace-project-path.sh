# Login shells reset PATH in /etc/profile before loading this file.
if [ -n "${WORKSPACE_PROJECT_TOOL_PATH:-}" ] && [ "$(id -u)" -eq 1000 ]; then
    export PATH="$WORKSPACE_PROJECT_TOOL_PATH"
fi
