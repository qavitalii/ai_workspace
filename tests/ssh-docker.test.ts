import { attachInput } from "../src/server/docker-attach";
import { consumeRunnerOutput } from "../src/server/runner-output";
import { describe, expect, it } from "vitest";
import Docker from "dockerode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  sshOperation,
  startSshHelper,
  cleanSshVolumes,
} from "../src/server/ssh-runtime";
import { config } from "../src/server/config";
const exec = promisify(execFile);
const docker = new Docker();
const cli = async (...args: string[]) =>
  (await exec("docker", args, { timeout: 45000, maxBuffer: 1024 * 1024 }))
    .stdout;

describe.skipIf(process.env.SSH_DOCKER_TESTS !== "1")(
  "isolated OpenSSH connections",
  () => {
    it("does not inject Docker attach metadata into the first input command", async () => {
      for (let i = 0; i < 10; i++) {
        const container = await docker.createContainer({
          Image: config.image,
          Cmd: [
            "node",
            "-e",
            'require("readline").createInterface({input:process.stdin}).once("line",text=>{console.log(JSON.stringify({type:"result",text}));process.exit(0)})',
          ],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          OpenStdin: true,
          HostConfig: { NetworkMode: "none" },
        });
        try {
          const stream = await attachInput(container);
          const events: any[] = [];
          const output = consumeRunnerOutput(stream, (e) => {
            events.push(e);
          });
          await container.start();
          stream.write("first command\n");
          await output;
          expect(events).toEqual([{ type: "result", text: "first command" }]);
        } finally {
          await container.remove({ force: true }).catch(() => {});
        }
      }
    }, 30000);

    it("imports encrypted keys, pins servers, transfers files and limits broker identities", async () => {
      config.data = "/tmp/ssh-tests-" + randomUUID();
      const key = await sshOperation({ operation: "generate" }).catch((e) => {
        throw new Error("generate: " + e.message);
      });
      expect(key.fingerprint).toMatch(/^SHA256:/);
      const encrypted = await cli(
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        config.image,
        "-c",
        "ssh-keygen -q -t ed25519 -N test-passphrase -f /tmp/import-key && cat /tmp/import-key",
      );
      const imported = await sshOperation({
        operation: "import",
        private_key: encrypted,
        passphrase: "test-passphrase",
      }).catch((e) => {
        throw new Error("encrypted import: " + e.message);
      });
      expect(imported.fingerprint).toMatch(/^SHA256:/);
      await expect(
        sshOperation({
          operation: "import",
          private_key: encrypted,
          passphrase: "wrong",
        }),
      ).rejects.toThrow();
      await expect(
        sshOperation({ operation: "import", private_key: "not a key" }),
      ).rejects.toThrow();
      for (const type of ["rsa", "ecdsa"]) {
        const pem = await cli(
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          config.image,
          "-c",
          `ssh-keygen -q -t ${type} -N '' -f /tmp/import-key && cat /tmp/import-key`,
        );
        const result = await sshOperation({
          operation: "import",
          private_key: pem,
        });
        expect(
          result.public_key.startsWith(
            type === "rsa" ? "ssh-rsa " : "ecdsa-sha2-",
          ),
        ).toBe(true);
      }
      const targets: Docker.Container[] = [];
      let broker: Awaited<ReturnType<typeof startSshHelper>> | undefined;
      const clients: Docker.Container[] = [];
      try {
        for (let i = 0; i < 2; i++) {
          const c = await docker.createContainer({
            Image: "ai-workspace-sshd:tests",
            HostConfig: { NetworkMode: "bridge" },
          });
          targets.push(c);
          await c.start();
          await cli(
            "exec",
            c.id,
            "sh",
            "-c",
            'printf "%s\\n" "$1" > /tmp/authorized_keys',
            "sh",
            key.public_key,
          );
        }
        const hosts = await Promise.all(
          targets.map(
            async (c) =>
              (await c.inspect()).NetworkSettings.Networks.bridge.IPAddress,
          ),
        );
        const s = {
          id: randomUUID(),
          key_id: randomUUID(),
          name: "Test",
          alias: "ssh-test",
          host: hosts[0],
          port: 2222,
          username: "tester",
          ...key,
          host_keys: [],
        };
        // sshd generates host keys at startup; bounded retries allow it to become ready.
        for (let i = 0; i < 10; i++) {
          try {
            s.host_keys = await sshOperation({ operation: "scan", server: s });
            break;
          } catch (e) {
            if (i === 9) throw e;
          }
        }
        expect(s.host_keys.length).toBeGreaterThan(0);
        expect(
          (await sshOperation({ operation: "test", servers: [s] })).ok,
        ).toBe(true);
        expect(
          (
            await sshOperation({
              operation: "test",
              servers: [{ ...s, username: "missing" }],
            })
          ).ok,
        ).toBe(false);
        const mismatch = await sshOperation({
          operation: "test",
          servers: [{ ...s, host: hosts[1] }],
        });
        expect(mismatch.ok).toBe(false);
        expect(mismatch.message).toContain("identity");
        expect(
          (
            await sshOperation({
              operation: "test",
              servers: [{ ...s, port: 1 }],
            })
          ).ok,
        ).toBe(false);
        broker = await startSshHelper(
          { operation: "broker", servers: [s] },
          true,
        );
        const volumeName = broker.mount.Source;
        const client = async (script: string, mount = true) => {
          const c = await docker.createContainer({
            Image: config.image,
            User: "1000:1000",
            Cmd: ["sh", "-c", script],
            HostConfig: {
              Mounts: mount ? [broker!.mount] : [],
              NetworkMode: "bridge",
              ReadonlyRootfs: true,
              Tmpfs: { "/tmp": "rw,uid=1000,gid=1000,size=8m" },
            },
          });
          clients.push(c);
          await c.start();
          return (await c.wait()).StatusCode;
        };
        expect(await client("ssh ssh-test true")).toBe(0);
        expect(
          await client(
            "printf 'transfer test' > /tmp/input && scp /tmp/input ssh-test:/tmp/transferred && scp ssh-test:/tmp/transferred /tmp/output && cmp /tmp/input /tmp/output",
          ),
        ).toBe(0);
        expect(
          await client(
            "printf 'get /tmp/transferred /tmp/sftp-output\\n' | sftp -b - ssh-test && test -s /tmp/sftp-output",
          ),
        ).toBe(0);
        expect(
          await client(
            "test ! -e /private/key && test ! -e /profile/.ssh/id_ed25519 && ! find /run/workspace-ssh -type f -exec grep -l 'PRIVATE KEY' {} +",
          ),
        ).toBe(0);
        expect(
          await client(
            `ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentityAgent=/run/workspace-ssh/agent.sock -o IdentitiesOnly=yes -i /run/workspace-ssh/${s.key_id}.pub -p 2222 tester@${hosts[1]} true`,
          ),
        ).not.toBe(0);
        expect(
          await client(
            `ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 tester@${hosts[0]} true`,
            false,
          ),
        ).not.toBe(0);
        for (const c of clients.splice(0)) await c.remove({ force: true });
        await broker.stop();
        broker = undefined;
        await expect(docker.getVolume(volumeName).inspect()).rejects.toThrow();
        const second = {
          ...s,
          id: randomUUID(),
          key_id: randomUUID(),
          alias: "second",
          host: hosts[1],
          host_keys: await sshOperation({
            operation: "scan",
            server: { ...s, host: hosts[1] },
          }),
        };
        broker = await startSshHelper(
          { operation: "broker", servers: [s, second] },
          true,
        );
        // Two saved entries for one private key retain both allowed destinations.
        expect(await client("ssh ssh-test true && ssh second true")).toBe(0);
        // Recovery removes public socket volumes left after a supervisor crash.
        const orphan = "workspace-ssh-orphan-" + randomUUID();
        await docker.createVolume({
          Name: orphan,
          Labels: {
            "ai.workspace.ssh": "true",
            "ai.workspace.instance": config.data,
          },
        });
        await cleanSshVolumes();
        await expect(docker.getVolume(orphan).inspect()).rejects.toThrow();
      } finally {
        for (const c of clients)
          await c.remove({ force: true }).catch(() => {});
        await broker?.stop();
        for (const c of targets)
          await c.remove({ force: true }).catch(() => {});
      }
    }, 180000);
  },
);
