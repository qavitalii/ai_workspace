import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  fingerprint,
  knownHosts,
  publicKey,
  serverInput,
  sshConfig,
} from "../src/ssh";

const alg = Buffer.from("ssh-ed25519");
const size = Buffer.alloc(4);
size.writeUInt32BE(alg.length);
const dataSize = Buffer.alloc(4);
dataSize.writeUInt32BE(32);
const key =
  "ssh-ed25519 " +
  Buffer.concat([size, alg, dataSize, Buffer.alloc(32, 1)]).toString("base64");
const server = {
  id: randomUUID(),
  key_id: randomUUID(),
  name: "Production",
  alias: "production",
  host: "example.test",
  username: "deploy",
  port: 2222,
  host_keys: [key],
  public_key: key,
};

describe("SSH configuration", () => {
  it("rejects shell/config injection and invalid ports without forbidding IPv6", () => {
    for (const host of [
      "-oProxyCommand=evil",
      "x\nProxyCommand evil",
      "x;evil",
      "$(evil)",
      "x y",
      "x/../../key",
    ])
      expect(serverInput.safeParse({ ...server, host }).success).toBe(false);
    for (const username of ["-root", "root\nHost *", "root@other"])
      expect(serverInput.safeParse({ ...server, username }).success).toBe(
        false,
      );
    for (const alias of ["*", "host?", "!host", "foo bar", "-host"])
      expect(serverInput.safeParse({ ...server, alias }).success).toBe(false);
    expect(serverInput.safeParse({ ...server, port: 0 }).success).toBe(false);
    expect(serverInput.safeParse({ ...server, port: 65536 }).success).toBe(
      false,
    );
    expect(serverInput.parse({ ...server, host: "2001:db8::1" }).host).toBe(
      "2001:db8::1",
    );
  });
  it("uses public identities, pinned host keys and explicit per-server credentials", () => {
    const config = sshConfig([server]);
    expect(config).toContain(
      "Host production\n  HostName example.test\n  Port 2222",
    );
    expect(config).toContain(
      "IdentityFile /run/workspace-ssh/" + server.key_id + ".pub",
    );
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(config).toContain("ForwardAgent no");
    expect(config).toContain("IdentityAgent none");
    expect(config).not.toContain("PRIVATE KEY");
    expect(knownHosts([server])).toBe("production " + key + "\n");
  });
  it("normalizes public keys, rejects hardware keys and calculates stable SHA256 fingerprints", () => {
    expect(publicKey(key + " user@host")).toBe(key);
    expect(fingerprint(key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(() => publicKey("ssh-ed25519 AAAA")).toThrow();
    expect(() => publicKey("sk-ssh-ed25519@openssh.com AAAA")).toThrow();
    expect(() => publicKey(key.replace("ssh-ed25519", "ssh-rsa"))).toThrow();
  });
});
