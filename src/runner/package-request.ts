export const packageSocket = "/run/workspace-packages/install.sock";
export const packagePresetDirectory = "/run/workspace-packages/preset";
export const packagePresetSocket = packagePresetDirectory + "/install.sock";
export const packageAuditPath = "/run/workspace-packages/installed.json";
export const maxPackageNames = 64;
export const maxPackageRequests = 64;
export const maxPackageRequestBytes = 8 * 1024;
export const packageNamePattern = "^[a-z0-9][a-z0-9+.-]{1,62}$";
const packageName = new RegExp(packageNamePattern);
export const packageUsage = `Usage: workspace-install <Debian package name> [name ...] (up to ${maxPackageNames} names).`;

export function packageNames(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maxPackageNames ||
    !value.every((name) => typeof name === "string" && packageName.test(name))
  )
    return null;
  return [...new Set<string>(value)];
}
