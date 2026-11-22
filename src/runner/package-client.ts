import { createConnection } from "node:net";
import { packageSocket } from "./package-request.js";

export type PackageInstallResult = { ok: boolean; output: string };

export async function installPackages(
  names: string[],
  signal?: AbortSignal,
): Promise<PackageInstallResult> {
  const reply = await requestPackages(packageSocket, names, signal);
  if (
    typeof reply === "object" &&
    reply !== null &&
    "ok" in reply &&
    "output" in reply &&
    typeof reply.ok === "boolean" &&
    typeof reply.output === "string"
  )
    return { ok: reply.ok, output: reply.output };
  throw new Error(invalidResult);
}

const invalidResult = "The package installer closed without a valid result.";

export function requestPackages(
  path: string,
  names: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted)
    return Promise.reject(new Error("Package installation was cancelled."));
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let reply = "";
    const abort = () =>
      socket.destroy(new Error("Package installation was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(260_000, () =>
      socket.destroy(new Error("Package installation timed out.")),
    );
    socket.on("connect", () => socket.write(JSON.stringify(names) + "\n"));
    socket.on("data", (chunk) => {
      reply += chunk;
      if (reply.length > 256 * 1024)
        socket.destroy(new Error("Package installer response is too long."));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        ["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")
          ? new Error("workspace-install is unavailable in this session.")
          : error,
      );
    });
    socket.once("close", () => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(invalidResult));
    });
    socket.once("end", () => {
      try {
        resolve(JSON.parse(reply));
      } catch {
        reject(new Error(invalidResult));
      }
    });
  });
}
