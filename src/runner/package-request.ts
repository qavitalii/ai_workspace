export const packageSocket = "/run/workspace-packages/install.sock";
export const packagePresetDirectory = "/run/workspace-packages/preset";
export const packagePresetSocket = packagePresetDirectory + "/install.sock";
export const packageAuditPath = "/run/workspace-packages/installed.json";
export const maxPackageNames = 64;
export const maxProjectPackages = 256;
export const packagePresetTimeout = 180_000;
export const maxPackageRequests = 64;
export const maxPackageRequestBytes = 8 * 1024;
export const packageNamePattern = "^[a-z0-9][a-z0-9+.-]{1,62}$";
const packageName = new RegExp(packageNamePattern);
export const packageUsage = `Usage: workspace-install <Debian package name> [name ...] (up to ${maxPackageNames} names).`;

export function validPackageName(name: unknown): name is string {
  return typeof name === "string" && packageName.test(name);
}

function namesWithinLimit(value: unknown, limit: number): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > limit ||
    !value.every(validPackageName)
  )
    return null;
  return [...new Set<string>(value)];
}

export function packageNames(value: unknown) {
  return namesWithinLimit(value, maxPackageNames);
}

export function projectPackageNames(value: unknown) {
  return namesWithinLimit(value, maxProjectPackages);
}

export type PackagePresetResult = { name: string; ok: boolean };

export function packagePresetResults(
  value: unknown,
): PackagePresetResult[] | null {
  if (!Array.isArray(value) || value.length > maxProjectPackages) return null;
  const results = new Map<string, PackagePresetResult>();
  for (const item of value) {
    if (
      !validPackageName(item?.name) ||
      typeof item.ok !== "boolean" ||
      results.has(item.name)
    )
      return null;
    results.set(item.name, { name: item.name, ok: item.ok });
  }
  return [...results.values()];
}
