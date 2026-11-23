import { validPackageName } from "./package-request.js";

const installFlags = new Set(["-y", "-q", "--no-install-recommends"]);

function installArguments(args: string[]): string[] | null {
  const names = args.filter((arg) => !installFlags.has(arg));
  return names.length > 0 && names.every(validPackageName) ? names : null;
}

function shellWords(command: string): string[] {
  return command.split(/[ \t]+/).filter(Boolean);
}

function parseWrappedApt(args: string[]): string[] | null {
  if (args.length !== 3 || args[0] !== "sh" || args[1] !== "-c") return null;

  // Treat the script as literal words. Never pass it to a shell.
  const commands = args[2].split("&&");
  if (commands.length !== 2) return null;

  const update = shellWords(commands[0]);
  if (update.length !== 2 || update[0] !== "apt-get" || update[1] !== "update")
    return null;

  const [apt, action, ...install] = shellWords(commands[1]);
  return apt === "apt-get" && action === "install"
    ? installArguments(install)
    : null;
}

export function parseSudoApt(args: string[]): "update" | string[] | null {
  if (args[0] === "sh") return parseWrappedApt(args);
  if (args[0] === "--") return parseWrappedApt(args.slice(1));

  const [apt, action, ...rest] = args[0] === "-n" ? args.slice(1) : args;
  if (apt !== "apt-get" && apt !== "apt") return null;
  if (action === "update" && rest.length === 0) return "update";
  return action === "install" ? installArguments(rest) : null;
}
