import type Docker from "dockerode";
import type { Duplex } from "node:stream";

// Docker's attach endpoint has no request body. dockerode's generic POST path
// serializes its query options as JSON; during an HTTP upgrade Docker can pass
// that body to container stdin, corrupting the first command nondeterministically.
// Supply an explicit zero-byte body while retaining docker-modem's transport
// support (Unix socket, TCP/TLS and SSH).
export function attachInput(container: Docker.Container): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    container.modem.dial(
      {
        path: `/containers/${container.id}/attach?`,
        method: "POST",
        isStream: true,
        hijack: true,
        openStdin: true,
        options: { stream: true, stdin: true, stdout: true, stderr: true },
        file: Buffer.alloc(0),
        headers: { "Content-Type": "application/octet-stream" },
        statusCodes: {
          200: true,
          404: "no such container",
          500: "server error",
        },
      },
      (error: Error | null, stream: Duplex) =>
        error ? reject(error) : resolve(stream),
    );
  });
}
