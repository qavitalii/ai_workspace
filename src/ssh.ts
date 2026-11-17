import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

export const serverInput = z.object({
  name: z.string().trim().min(1).max(100),
  alias: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  host: z
    .string()
    .max(253)
    .refine(
      (s) =>
        isIP(s) !== 0 ||
        /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(s),
    ),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}\$?$/),
  key_id: z.uuid(),
});
export type SshServer = z.infer<typeof serverInput> & {
  id: string;
  host_keys: string[];
  public_key: string;
  private_key?: string;
};

export function publicKey(value: string) {
  const parts = value.trim().split(/\s+/);
  if (
    !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(parts[0]) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1] || "")
  )
    throw new Error("Unsupported SSH public key");
  const bytes = Buffer.from(parts[1], "base64");
  if (
    bytes.length < 8 ||
    bytes.length > 16384 ||
    bytes.readUInt32BE(0) !== parts[0].length ||
    bytes.subarray(4, 4 + parts[0].length).toString() !== parts[0]
  )
    throw new Error("Invalid SSH public key");
  return `${parts[0]} ${bytes.toString("base64")}`;
}
export function fingerprint(key: string) {
  return (
    "SHA256:" +
    createHash("sha256")
      .update(Buffer.from(publicKey(key).split(" ")[1], "base64"))
      .digest("base64")
      .replace(/=+$/, "")
  );
}
export function knownHosts(servers: SshServer[]) {
  return (
    servers
      .flatMap((s) => s.host_keys.map((k) => `${s.alias} ${publicKey(k)}`))
      .join("\n") + "\n"
  );
}
export function sshConfig(servers: SshServer[]) {
  return (
    servers
      .map((s) => {
        serverInput.parse(s);
        return `Host ${s.alias}\n  HostName ${s.host}\n  Port ${s.port}\n  User ${s.username}\n  HostKeyAlias ${s.alias}\n  IdentityAgent /run/workspace-ssh/agent.sock\n  IdentityFile /run/workspace-ssh/${s.key_id}.pub\n`;
      })
      .join("\n") +
    `\nHost *\n  BatchMode yes\n  IdentitiesOnly yes\n  IdentityAgent none\n  IdentityFile none\n  StrictHostKeyChecking yes\n  UserKnownHostsFile /run/workspace-ssh/known_hosts\n  GlobalKnownHostsFile /dev/null\n  ForwardAgent no\n  ConnectTimeout 10\n  ConnectionAttempts 1\n  ServerAliveInterval 15\n  ServerAliveCountMax 2\n`
  );
}
