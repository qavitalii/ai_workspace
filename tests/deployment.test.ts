import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "..");
const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0))
    rmSync(fixture, { recursive: true, force: true });
});

function parseHost(host: string) {
  return spawnSync("python3", ["ops/server-address.py", host], {
    cwd: repository,
    encoding: "utf8",
  });
}

describe("server address validation", () => {
  it.each([
    [" Agents.Example.com ", "agents.example.com agents.example.com Caddyfile"],
    ["8.8.8.8", "8.8.8.8 8.8.8.8 Caddyfile.ip"],
    [
      "2606:4700:4700:0:0:0:0:1111",
      "2606:4700:4700::1111 [2606:4700:4700::1111] Caddyfile.ip",
    ],
    [
      "[2606:4700:4700::1111]",
      "2606:4700:4700::1111 [2606:4700:4700::1111] Caddyfile.ip",
    ],
  ])("normalizes %s without resolving or contacting it", (input, output) => {
    const result = parseHost(input);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(output);
  });

  it.each([
    "",
    "localhost",
    "host.local",
    "host.internal",
    "host.home.arpa",
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "0.0.0.0",
    "224.0.0.1",
    "240.0.0.1",
    "203.0.113.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:8.8.8.8",
    "fe80::1%eth0",
    "2606:4700:4700::1111%eth0",
    "999.1.2.3",
    "01.2.3.4",
    "8.8.8.8:443",
    "[2606:4700:4700::1111]:443",
    "[8.8.8.8]",
    "https://example.com",
    "example.com/path",
    "example.com?x=1",
    "a..example.com",
    "-bad.example.com",
    "bad-.example.com",
    "*.example.com",
    "example.com\nNODE_ENV=development",
    "$(touch /tmp/unwanted).com",
    "example.com;echo",
    "example.com`echo`",
    "a".repeat(64) + ".com",
  ])("rejects %s before creating settings", (input) => {
    const result = parseHost(input);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Enter|public IP|IPv6/);
  });
});

function installerFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "workspace-install-"));
  fixtures.push(root);
  mkdirSync(path.join(root, "ops"));
  mkdirSync(path.join(root, "bin"));
  for (const file of ["install.sh", "maintenance-lock.sh", "server-address.py"])
    copyFileSync(
      path.join(repository, "ops", file),
      path.join(root, "ops", file),
    );
  // Simulate Docker and an existing owner; never start services or touch host setup.
  writeFileSync(path.join(root, "bin", "uname"), "#!/bin/sh\necho Darwin\n", {
    mode: 0o755,
  });
  writeFileSync(
    path.join(root, "bin", "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> docker-calls
case "$*" in
  *"SELECT EXISTS"*) echo t ;;
  *"SELECT count"*) echo 1 ;;
  *"webpush.generateVAPIDKeys"*) printf 'VAPID_PUBLIC_KEY=test-public\\nVAPID_PRIVATE_KEY=test-private\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    root,
    run(mode: string, input = "") {
      return spawnSync("bash", ["ops/install.sh", mode], {
        cwd: root,
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
        input,
        encoding: "utf8",
      });
    },
    settings() {
      return Object.fromEntries(
        readFileSync(path.join(root, ".env"), "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const index = line.indexOf("=");
            return [line.slice(0, index), line.slice(index + 1)];
          }),
      );
    },
  };
}

// The production installer enables system backups when run as root.
describe.skipIf(process.getuid?.() === 0)("installation modes", () => {
  it.each([
    ["8.8.8.8", "https://8.8.8.8", "8.8.8.8", "8.8.8.8", "Caddyfile.ip"],
    [
      "2606:4700:4700::1111",
      "https://[2606:4700:4700::1111]",
      "[2606:4700:4700::1111]",
      "2606:4700:4700::1111",
      "Caddyfile.ip",
    ],
    [
      "agents.example.com",
      "https://agents.example.com",
      "agents.example.com",
      "agents.example.com",
      "Caddyfile",
    ],
  ])(
    "installs %s with HTTPS and preserves settings on rerun",
    (host, origin, address, tlsName, caddyConfig) => {
      const fixture = installerFixture();
      const result = fixture.run("--server", `${host}\n`);
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.settings()).toMatchObject({
        APP_ORIGIN: origin,
        SITE_ADDRESS: address,
        NODE_ENV: "production",
        TLS_SERVER_NAME: tlsName,
        CADDY_CONFIG: caddyConfig,
        HTTP_BIND: address.startsWith("[") ? "[::]" : "0.0.0.0",
        HTTPS_BIND: address.startsWith("[") ? "[::]" : "0.0.0.0",
      });
      expect(result.stdout).toContain(origin);
      expect(statSync(path.join(fixture.root, ".env")).mode & 0o777).toBe(
        0o600,
      );
      expect(statSync(path.join(fixture.root, ".data")).mode & 0o777).toBe(
        0o700,
      );
      for (const key of ["POSTGRES_PASSWORD", "ENCRYPTION_KEY"]) {
        expect(result.stdout + result.stderr).not.toContain(
          fixture.settings()[key],
        );
      }
      const original = readFileSync(path.join(fixture.root, ".env"), "utf8");
      expect(fixture.run("--server").status).toBe(0);
      expect(readFileSync(path.join(fixture.root, ".env"), "utf8")).toBe(
        original,
      );
    },
  );

  it("keeps local access on HTTP and the original Caddy config", () => {
    const fixture = installerFixture();
    const result = fixture.run("--local");
    expect(result.status, result.stderr).toBe(0);
    expect(fixture.settings()).toMatchObject({
      APP_ORIGIN: "http://localhost:8080",
      SITE_ADDRESS: ":80",
      NODE_ENV: "development",
      CADDY_CONFIG: "Caddyfile",
    });
    expect(
      readFileSync(path.join(fixture.root, "docker-calls"), "utf8"),
    ).toContain("-f compose.yaml -f compose.local.yaml");
  });

  it("does not leave a partial .env or start services for a private IP", () => {
    const fixture = installerFixture();
    const result = fixture.run("--server", "192.168.1.1\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public IP");
    expect(existsSync(path.join(fixture.root, ".env"))).toBe(false);
    expect(
      readFileSync(path.join(fixture.root, "docker-calls"), "utf8"),
    ).not.toMatch(/build|up -d/);
  });

  it("preserves legacy domain installations without the new settings", () => {
    const fixture = installerFixture();
    expect(fixture.run("--server", "agents.example.com\n").status).toBe(0);
    const envPath = path.join(fixture.root, ".env");
    const legacy = readFileSync(envPath, "utf8")
      .split("\n")
      .filter(
        (line) =>
          !/^(CADDY_CONFIG|TLS_SERVER_NAME|HTTP_BIND|HTTPS_BIND)=/.test(line),
      )
      .join("\n");
    writeFileSync(envPath, legacy);
    expect(fixture.run("--server").status).toBe(0);
    expect(readFileSync(envPath, "utf8")).toBe(legacy);
  });

  it("refuses changing install modes without altering existing secrets", () => {
    const fixture = installerFixture();
    expect(fixture.run("--local").status).toBe(0);
    const original = readFileSync(path.join(fixture.root, ".env"), "utf8");
    const result = fixture.run("--server", "8.8.8.8\n");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("different mode");
    expect(readFileSync(path.join(fixture.root, ".env"), "utf8")).toBe(
      original,
    );
  });
});

describe.skipIf(process.env.COMPOSE_TESTS !== "1")(
  "effective Docker publication",
  () => {
    it.each(["legacy-domain", "ipv4", "ipv6", "local"])(
      "keeps expected mounts and network boundaries for %s",
      (mode) => {
        const root = mkdtempSync(path.join(os.tmpdir(), "workspace-compose-"));
        fixtures.push(root);
        const envFile = path.join(root, "test.env");
        const values = [
          "POSTGRES_PASSWORD=test-only",
          "ENCRYPTION_KEY=" + "a".repeat(64),
          "DATA_ROOT=" + root,
          "APP_ORIGIN=https://8.8.8.8",
          "SITE_ADDRESS=8.8.8.8",
        ];
        if (mode !== "legacy-domain")
          values.push("CADDY_CONFIG=Caddyfile.ip", "TLS_SERVER_NAME=8.8.8.8");
        if (mode === "ipv6") values.push("HTTP_BIND=[::]", "HTTPS_BIND=[::]");
        writeFileSync(envFile, values.join("\n"));
        const args = [
          "compose",
          "--env-file",
          envFile,
          "-f",
          path.join(repository, "compose.yaml"),
        ];
        if (mode === "local")
          args.push("-f", path.join(repository, "compose.local.yaml"));
        // Explicit synthetic settings: never load the checkout's secret .env.
        const env = { ...process.env };
        for (const key of Object.keys(env))
          if (
            /^(COMPOSE_|HTTP_BIND$|HTTPS_BIND$|CADDY_CONFIG$|TLS_SERVER_NAME$|SITE_ADDRESS$|APP_ORIGIN$|DATA_ROOT$|POSTGRES_PASSWORD$|ENCRYPTION_KEY$)/.test(
              key,
            )
          )
            delete env[key];
        const result = spawnSync(
          "docker",
          [...args, "config", "--format", "json"],
          { env, encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        const services = JSON.parse(result.stdout).services;
        const proxy = services.caddy;
        expect(services.db.ports).toBeUndefined();
        expect(services.server.ports).toBeUndefined();
        expect(
          proxy.volumes.find(
            (v: { target: string }) => v.target === "/etc/caddy/Caddyfile",
          ),
        ).toMatchObject({
          source: path.join(
            repository,
            "ops",
            mode === "ipv4" || mode === "ipv6" ? "Caddyfile.ip" : "Caddyfile",
          ),
          read_only: true,
        });
        if (mode === "local") {
          expect(proxy.ports).toHaveLength(1);
          expect(proxy.ports[0]).toMatchObject({
            host_ip: "127.0.0.1",
            published: "8080",
            target: 80,
          });
          expect(proxy.environment.SITE_ADDRESS).toBe(":80");
        } else {
          expect(proxy.ports.map((p: { target: number }) => p.target)).toEqual([
            80, 443,
          ]);
          expect(
            proxy.ports.every(
              (p: { host_ip: string }) =>
                p.host_ip === (mode === "ipv6" ? "::" : "0.0.0.0"),
            ),
          ).toBe(true);
        }
      },
    );
  },
);

// Offline checks with the real proxy parser. CI uses the exact Compose image;
// local development can supply a downloaded Caddy binary instead of Docker.
describe.skipIf(!process.env.CADDY_BIN && process.env.CADDY_TESTS !== "1")(
  "Caddy HTTPS configuration",
  () => {
    function adapt(file: string, address: string, tlsName = "") {
      const args = [
        "adapt",
        "--adapter",
        "caddyfile",
        "--config",
        `/config/${file}`,
      ];
      let result;
      if (process.env.CADDY_BIN) {
        result = spawnSync(
          process.env.CADDY_BIN,
          [
            "adapt",
            "--adapter",
            "caddyfile",
            "--config",
            path.join(repository, "ops", file),
          ],
          {
            env: {
              ...process.env,
              SITE_ADDRESS: address,
              TLS_SERVER_NAME: tlsName,
            },
            encoding: "utf8",
          },
        );
      } else {
        const image = readFileSync(
          path.join(repository, "compose.yaml"),
          "utf8",
        ).match(/image: (caddy:[^\s]+)/)![1];
        result = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            "none",
            "-e",
            `SITE_ADDRESS=${address}`,
            "-e",
            `TLS_SERVER_NAME=${tlsName}`,
            "-v",
            `${repository}/ops:/config:ro`,
            image,
            "caddy",
            ...args,
          ],
          { encoding: "utf8" },
        );
      }
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    }

    it.each([
      ["8.8.8.8", "8.8.8.8"],
      ["[2606:4700:4700::1111]", "2606:4700:4700::1111"],
    ])(
      "uses public ACME and handles missing browser SNI for %s",
      (address, host) => {
        const result = adapt("Caddyfile.ip", address, host);
        expect(result.apps.tls.automation.policies).toEqual([
          {
            subjects: [host],
            issuers: [
              {
                module: "acme",
                ca: "https://acme-v02.api.letsencrypt.org/directory",
                profile: "shortlived",
              },
            ],
          },
        ]);
        const server = result.apps.http.servers.srv0;
        expect(server.listen).toEqual([":443"]);
        expect(server.routes[0].match[0].host).toEqual([host]);
        expect(
          server.tls_connection_policies.every(
            (policy: { default_sni: string }) => policy.default_sni === host,
          ),
        ).toBe(true);
      },
    );

    it("preserves ordinary domain TLS and localhost HTTP", () => {
      const domain = adapt("Caddyfile", "agents.example.com");
      expect(domain.apps.http.servers.srv0.listen).toEqual([":443"]);
      expect(
        domain.apps.tls?.automation?.policies?.some(
          (p: { issuers?: unknown[] }) => p.issuers,
        ),
      ).not.toBe(true);
      const local = adapt("Caddyfile", ":80");
      expect(local.apps.http.servers.srv0.listen).toEqual([":80"]);
      expect(local.apps.tls).toBeUndefined();
    });
  },
);
