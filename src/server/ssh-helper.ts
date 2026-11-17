// Runs only in a disposable trusted container. Never log input or child output:
// the import result and broker input contain private key material.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  fingerprint,
  publicKey,
  knownHosts,
  sshConfig,
  type SshServer,
} from "../ssh.js";
const exec = promisify(execFile);
const emit = (data: unknown) =>
  process.stdout.write(JSON.stringify(data) + "\n");
const run = (cmd: string, args: string[], env = process.env) =>
  exec(cmd, args, { env, timeout: 15000, maxBuffer: 65536 });

async function unlock(passphrase: string) {
  const pty = await import("node-pty");
  await new Promise<void>((resolve, reject) => {
    const child = pty.spawn("ssh-keygen", ["-p", "-f", "/private/key"], {
      name: "xterm",
      cols: 200,
      rows: 24,
      env: { ...process.env, LC_ALL: "C" },
    });
    let output = "",
      oldSent = false,
      newSent = false,
      repeatSent = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("key"));
    }, 10000);
    child.onData((data) => {
      output = (output + data).slice(-4096);
      if (!oldSent && output.includes("Enter old passphrase:")) {
        oldSent = true;
        output = "";
        child.write(passphrase + "\r");
      }
      if (!newSent && output.includes("Enter new passphrase")) {
        newSent = true;
        output = "";
        child.write("\r");
      }
      if (!repeatSent && output.includes("Enter same passphrase again:")) {
        repeatSent = true;
        output = "";
        child.write("\r");
      }
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      exitCode === 0 ? resolve() : reject(new Error("key"));
    });
  });
}

async function broker(servers: SshServer[]) {
  await chmod("/run/workspace-ssh", 0o700);
  await writeFile("/run/workspace-ssh/known_hosts", knownHosts(servers), {
    mode: 0o600,
  });
  await writeFile("/run/workspace-ssh/config", sshConfig(servers), {
    mode: 0o600,
  });
  const agent = spawn(
    "ssh-agent",
    ["-D", "-a", "/run/workspace-ssh/agent.sock", "-P", ""],
    { stdio: "ignore" },
  );
  const env = {
    ...process.env,
    SSH_AUTH_SOCK: "/run/workspace-ssh/agent.sock",
  };
  let exited = false;
  agent.on("error", () => {
    exited = true;
  });
  agent.on("exit", () => {
    exited = true;
    process.exit(1);
  });
  for (let i = 0; ; i++) {
    try {
      await run("ssh-add", ["-D"], env);
      break;
    } catch {
      if (exited || i > 100) throw new Error("broker");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  // Re-importing the same key under another name must not replace its earlier
  // destination constraints in ssh-agent. Load each identity once with its union.
  for (const identity of new Set(servers.map((s) => publicKey(s.public_key)))) {
    const selected = servers.filter(
      (s) => publicKey(s.public_key) === identity,
    );
    for (const keyId of new Set(selected.map((s) => s.key_id)))
      await writeFile(`/run/workspace-ssh/${keyId}.pub`, identity + "\n", {
        mode: 0o600,
      });
    await writeFile("/private/key", selected[0].private_key!, { mode: 0o600 });
    try {
      await run(
        "ssh-add",
        [
          "-H",
          "/run/workspace-ssh/known_hosts",
          ...selected.flatMap((s) => ["-h", `${s.username}@${s.alias}`]),
          "/private/key",
        ],
        env,
      );
    } finally {
      await unlink("/private/key");
    }
  }
  return agent;
}

async function main(input: any) {
  if (input.operation === "generate" || input.operation === "import") {
    if (input.operation === "generate")
      await run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "workspace",
        "-f",
        "/private/key",
      ]);
    else {
      await writeFile("/private/key", input.private_key.trim() + "\n", {
        mode: 0o600,
      });
      await unlock(input.passphrase || "");
    }
    const key = publicKey(
      (await run("ssh-keygen", ["-y", "-f", "/private/key"])).stdout,
    );
    emit({
      type: "result",
      result: {
        public_key: key,
        fingerprint: fingerprint(key),
        private_key: await readFile("/private/key", "utf8"),
      },
    });
    await unlink("/private/key");
  } else if (input.operation === "scan") {
    const { host, port } = input.server;
    const { stdout } = await run("ssh-keyscan", [
      "-T",
      "5",
      "-p",
      String(port),
      "-t",
      "ed25519,ecdsa,rsa",
      host,
    ]);
    const keys = [
      ...new Set(
        stdout
          .split("\n")
          .filter((s) => s && !s.startsWith("#"))
          .map((s) => publicKey(s.split(/\s+/).slice(1).join(" "))),
      ),
    ];
    if (!keys.length) throw new Error("scan");
    emit({ type: "result", result: keys });
  } else if (input.operation === "broker" || input.operation === "test") {
    const agent = await broker(input.servers);
    if (input.operation === "broker") {
      emit({ type: "result", result: { ready: true } });
      return;
    }
    try {
      await run("ssh", [
        "-F",
        "/run/workspace-ssh/config",
        input.servers[0].alias,
        "true",
      ]);
      emit({
        type: "result",
        result: { ok: true, message: "Connected successfully." },
      });
    } catch (e: any) {
      const text = String(e.stderr || "");
      const message = /HOST IDENTIFICATION|Host key verification/i.test(text)
        ? "Server identity changed or is not trusted. Verify its fingerprint again."
        : /Permission denied/i.test(text)
          ? "Authentication rejected. Check the username and install the public key on the server."
          : /resolve hostname/i.test(text)
            ? "The server address could not be resolved."
            : /refused/i.test(text)
              ? "Connection refused. Check the SSH port and service."
              : "Connection timed out or was interrupted. Check the address, network and SSH service.";
      emit({ type: "result", result: { ok: false, message } });
    } finally {
      agent.kill();
    }
  } else throw new Error("operation");
}
const input = createInterface({ input: process.stdin });
input.once("line", (line) => {
  input.close();
  void Promise.resolve()
    .then(() => main(JSON.parse(line)))
    .catch(() => {
      emit({
        type: "error",
        error:
          "SSH operation failed. Check the key, passphrase, server address and availability.",
      });
      process.exit(1);
    });
});
