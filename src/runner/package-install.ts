import { installPackages } from "./package-client.js";
import { packageNames, packageUsage } from "./package-request.js";

const names = packageNames(process.argv.slice(2));
if (!names) {
  console.error(packageUsage);
  process.exitCode = 2;
} else {
  try {
    const { ok, output } = await installPackages(names);
    (ok ? console.log : console.error)(output);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
