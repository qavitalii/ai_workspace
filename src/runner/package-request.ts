export const packageSocket = "/run/workspace-packages/install.sock";
export const packagePresetDirectory = "/run/workspace-packages/preset";
export const packagePresetSocket = packagePresetDirectory + "/install.sock";
export const packageAuditPath = "/run/workspace-packages/installed.json";
export const maxProjectPackages = 256;
export const packagePresetTimeout = 180_000;
export const maxPackageRequests = 64;
export const maxPackageRequestBytes = 8 * 1024;
export const packageNamePattern = "^[a-z0-9][a-z0-9+.-]{1,62}$";
const packageName = new RegExp(packageNamePattern);
export const packageRequestLimit = `The JSON package list must fit in ${maxPackageRequestBytes / 1024} KiB.`;
export const packageUsage = `Usage: workspace-install <Debian package name> [name ...]. ${packageRequestLimit}`;

export function validPackageName(name: unknown): name is string {
  return typeof name === "string" && packageName.test(name);
}

export function exactPackagePattern(name: string) {
  return `?and(?exact-name(${name}),?not(?virtual))`;
}

function validPackageNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every(validPackageName)
  );
}

export function packageNames(value: unknown) {
  // Valid names are ASCII. Include the newline used by the broker protocol.
  if (
    !validPackageNames(value) ||
    JSON.stringify(value).length + 1 > maxPackageRequestBytes
  )
    return null;
  return [...new Set(value)];
}

export function projectPackageNames(value: unknown) {
  if (!validPackageNames(value) || value.length > maxProjectPackages)
    return null;
  return [...new Set(value)];
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
