import { installPackages } from "./package-client.js";
import { packageNames, packageUsage } from "./package-request.js";

export async function runPackageInstall(args: string[]): Promise<number> {
  const names = packageNames(args);
  if (!names) {
    console.error(packageUsage);
    return 2;
  }
  try {
    const { ok, output } = await installPackages(names);
    (ok ? console.log : console.error)(output);
    return ok ? 0 : 1;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}
