export const packageSocket = "/run/workspace-packages/install.sock";
export const packageAuditPath = "/run/workspace-packages/installed.json";
export const packageUsage =
  "Usage: workspace-install <Debian package name> [name ...] (up to 16 names).";

export function packageNames(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 16 ||
    !value.every(
      (name) =>
        typeof name === "string" && /^[a-z0-9][a-z0-9+.-]{1,62}$/.test(name),
    )
  )
    return null;
  return [...new Set<string>(value)];
}
