import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

// Test certificates are trusted only by these clients. No public address or CA
// is contacted, and nothing is added to the operating system's trust store.
describe.skipIf(process.env.CADDY_HTTPS_TESTS !== "1")(
  "IP HTTPS transport",
  () => {
    it.each(["8.8.8.8", "2606:4700:4700::1111"])(
      "serves the IP certificate without SNI and proxies HTTP/WebSockets for %s",
      async (host) => {
        const binary = process.env.CADDY_BIN;
        expect(binary, "Set CADDY_BIN to the Caddy executable").toBeTruthy();
        const root = await mkdtemp(
          path.join(os.tmpdir(), "workspace-ip-https-"),
        );
        const authority = host.includes(":") ? `[${host}]` : host;
        const origin = `https://${authority}`;
        let proxy: ChildProcess | undefined;
        let proxyLogs = "";
        const upstream = http.createServer((req, res) => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              host: req.headers.host,
              forwarded: req.headers["x-forwarded-for"],
              origin: req.headers.origin,
            }),
          );
        });
        const websocket = new WebSocketServer({ server: upstream });
        websocket.on("connection", (socket) =>
          socket.on("message", (message) => socket.send(message)),
        );
        websocket.on("error", () => {});
        async function stopProxy() {
          if (proxy && proxy.exitCode === null && proxy.signalCode === null) {
            const stopped = once(proxy, "exit");
            proxy.kill("SIGTERM");
            await stopped;
          }
        }
        try {
          await writeFile(
            path.join(root, "openssl.cnf"),
            `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=IP proxy test\n[ext]\nsubjectAltName=IP:${host}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`,
          );
          const certificate = path.join(root, "cert.pem");
          const key = path.join(root, "key.pem");
          const generated = spawnSync(
            "openssl",
            [
              "req",
              "-x509",
              "-newkey",
              "rsa:2048",
              "-nodes",
              "-days",
              "1",
              "-config",
              path.join(root, "openssl.cnf"),
              "-keyout",
              key,
              "-out",
              certificate,
            ],
            { encoding: "utf8", timeout: 10000 },
          );
          expect(generated.status, generated.stderr).toBe(0);
          const listening = once(upstream, "listening");
          upstream.listen(0, "127.0.0.1");
          await listening;
          const upstreamPort = (upstream.address() as net.AddressInfo).port;
          const reservation = net.createServer();
          const reserved = once(reservation, "listening");
          reservation.listen(0, "127.0.0.1");
          await reserved;
          const port = (reservation.address() as net.AddressInfo).port;
          await new Promise<void>((resolve) =>
            reservation.close(() => resolve()),
          );

          const adapted = spawnSync(
            binary!,
            [
              "adapt",
              "--config",
              path.resolve("ops/Caddyfile.ip"),
              "--adapter",
              "caddyfile",
            ],
            {
              env: {
                ...process.env,
                SITE_ADDRESS: authority,
                TLS_SERVER_NAME: host,
              },
              encoding: "utf8",
              timeout: 10000,
            },
          );
          expect(adapted.status, adapted.stderr).toBe(0);
          const config = JSON.parse(adapted.stdout);
          config.admin = { disabled: true };
          // Replace issuance only; retain real host routing, SNI and proxy rules.
          config.apps.tls = {
            certificates: { load_files: [{ certificate, key }] },
          };
          const server = config.apps.http.servers.srv0;
          server.listen = [`127.0.0.1:${port}`];
          server.automatic_https = {
            disable_certificates: true,
            disable_redirects: true,
          };
          function replaceUpstream(value: any) {
            if (!value || typeof value !== "object") return;
            for (const name of Object.keys(value)) {
              if (name === "dial" && value[name] === "server:3000")
                value[name] = `127.0.0.1:${upstreamPort}`;
              else replaceUpstream(value[name]);
            }
          }
          replaceUpstream(config);
          const configFile = path.join(root, "config.json");
          await writeFile(configFile, JSON.stringify(config));
          const options = {
            ca: await readFile(certificate),
            servername: "", // IP URLs do not send SNI, including behind Docker/NAT.
            // Verify the IP SAN directly: some Node 22 builds incorrectly
            // apply DNS normalization to bare IPv6 in checkServerIdentity.
            checkServerIdentity: (_name: string, cert: tls.PeerCertificate) =>
              new X509Certificate(cert.raw).checkIP(host)
                ? undefined
                : new Error("Certificate does not cover the requested IP"),
          };
          async function request(requestHost = authority) {
            return new Promise<{ status: number | undefined; body: string }>(
              (resolve, reject) => {
                const req = https.get(
                  {
                    host: "127.0.0.1",
                    port,
                    ...options,
                    headers: {
                      host: requestHost,
                      origin,
                      "x-forwarded-for": "spoofed-client",
                    },
                  },
                  (res) => {
                    let body = "";
                    res.on("data", (chunk) => (body += chunk));
                    res.on("end", () =>
                      resolve({ status: res.statusCode, body }),
                    );
                  },
                );
                req.setTimeout(2000, () =>
                  req.destroy(new Error("HTTPS request timed out")),
                );
                req.on("error", reject);
              },
            );
          }
          async function startProxy() {
            proxy = spawn(binary!, ["run", "--config", configFile], {
              env: {
                ...process.env,
                XDG_DATA_HOME: path.join(root, "data"),
                XDG_CONFIG_HOME: path.join(root, "config"),
              },
              stdio: ["ignore", "ignore", "pipe"],
            });
            proxy.stderr!.on("data", (chunk) => (proxyLogs += chunk));
            for (let attempt = 0; attempt < 50; attempt++) {
              try {
                return await request();
              } catch (error: any) {
                if (error.code !== "ECONNREFUSED" || proxy.exitCode !== null)
                  throw new Error(`${error.message}\n${proxyLogs}`);
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
            }
            throw new Error(`Caddy did not start: ${proxyLogs}`);
          }
          const response = await startProxy();
          expect(response.status).toBe(200);
          expect(JSON.parse(response.body)).toEqual({
            host: authority,
            forwarded: "127.0.0.1",
            origin,
          });
          // A certificate fallback must not become a catch-all HTTP host route.
          expect((await request("unrelated.example.com")).body).not.toContain(
            '"forwarded"',
          );
          const socket = new WebSocket(`wss://127.0.0.1:${port}/api/events`, {
            ...options,
            handshakeTimeout: 3000,
            headers: { host: authority, origin },
          });
          try {
            await once(socket, "open");
            const message = once(socket, "message");
            socket.send("chat-stream");
            expect(String((await message)[0])).toBe("chat-stream");
          } finally {
            socket.terminate();
          }
          await stopProxy();
          expect((await startProxy()).status).toBe(200);
        } finally {
          await stopProxy();
          for (const client of websocket.clients) client.terminate();
          websocket.close();
          upstream.closeAllConnections();
          await new Promise<void>((resolve) => upstream.close(() => resolve()));
          await rm(root, { recursive: true, force: true });
        }
      },
      20000,
    );
  },
);
