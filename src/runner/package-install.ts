import { runPackageInstall } from "./package-install-cli.js";

process.exitCode = await runPackageInstall(process.argv.slice(2));
