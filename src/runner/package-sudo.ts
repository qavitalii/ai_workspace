import { runPackageInstall } from "./package-install-cli.js";
import { parseSudoApt } from "./sudo-apt.js";

const request = parseSudoApt(process.argv.slice(2));
if (request === null) {
  console.error(
    "Workspace sudo supports only apt/apt-get update and install from the configured Debian repositories. Use workspace-install <package> [package ...] for package names.",
  );
  process.exitCode = 2;
} else if (request !== "update") {
  process.exitCode = await runPackageInstall(request);
}
