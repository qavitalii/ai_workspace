import Fastify from "fastify";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { awsRoutes, awsForRun } from "../src/server/aws";
import { config } from "../src/server/config";
import { seal } from "../src/server/security";
import { db } from "../src/server/db";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/server/db", () => ({ db: { query } }));

const app = Fastify();
awsRoutes(app);
const project = "00000000-0000-4000-8000-000000000001";
const endpoint = `/api/projects/${project}/aws`;
const settings = {
  ssoRegion: "eu-west-1",
  region: "eu-west-1",
  accountId: "123456789012",
  role: "ReadOnlyAccess",
  required: false,
};

beforeEach(() => {
  query.mockReset().mockResolvedValue({
    command: "SELECT",
    rowCount: 1,
    oid: 0,
    fields: [],
    rows: [],
  });
});

describe("AWS availability for new runs", () => {
  const originalPath = process.env.PATH;
  const originalKey = config.key;
  let fake = "";
  afterEach(async () => {
    process.env.PATH = originalPath;
    config.key = originalKey;
    if (fake) await rm(fake, { recursive: true, force: true });
    fake = "";
  });
  async function unavailable(required: boolean) {
    config.key = "ab".repeat(32);
    fake = await mkdtemp(path.join(tmpdir(), "aws-unavailable-"));
    await writeFile(path.join(fake, "aws"), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
    process.env.PATH = fake;
    query.mockResolvedValue({
      rows: [
        {
          settings: {
            ...settings,
            startUrl: "https://test.awsapps.com/start",
            required,
          },
          session: seal(JSON.stringify({ ["a".repeat(40) + ".json"]: "{}" })),
          generation: "test-generation",
        },
      ],
    });
  }
  it("continues without AWS and supplies a warning when optional access expires", async () => {
    await unavailable(false);
    const result = await awsForRun(project);
    expect(result.access).toBeNull();
    expect(result.warning).toContain("started without AWS access");
  });
  it("blocks the run when required access is unavailable", async () => {
    await unavailable(true);
    await expect(awsForRun(project)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("enforces required access even before the first sign-in", async () => {
    query.mockResolvedValue({
      rows: [{ settings: { ...settings, required: true }, session: null }],
    });
    await expect(awsForRun(project)).rejects.toThrow("AWS is required");
    query.mockResolvedValue({ rows: [{ settings, session: null }] });
    expect(await awsForRun(project)).toEqual({ access: null, warning: "" });
  });
  it("does not suppress database or corrupted-session failures", async () => {
    query.mockRejectedValue(new Error("database unavailable"));
    await expect(awsForRun(project)).rejects.toThrow("database unavailable");
    config.key = "ab".repeat(32);
    query.mockResolvedValue({
      rows: [{ settings, session: "corrupt", generation: "test" }],
    });
    await expect(awsForRun(project)).rejects.toThrow();
  });
});
afterAll(() => app.close());

describe("AWS SSO device sign-in", () => {
  const originalPath = process.env.PATH;
  const loginEndpoint = endpoint + "/connect";
  let fake = "";

  async function fakeAws(script: string) {
    fake = await mkdtemp(path.join(tmpdir(), "aws-device-"));
    await writeFile(path.join(fake, "aws"), "#!/bin/sh\n" + script, {
      mode: 0o700,
    });
    process.env.PATH = fake;
    query.mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          settings: { ...settings, startUrl: "https://test.awsapps.com/start" },
          session: null,
          identity: null,
        },
      ],
    });
  }

  afterEach(async () => {
    await app.inject({ method: "DELETE", url: loginEndpoint });
    process.env.PATH = originalPath;
    if (fake) await rm(fake, { recursive: true, force: true });
    fake = "";
  });

  it.each([
    "https://device.sso.eu-west-1.amazonaws.com/",
    "https://eu-west-1.signin.aws/platform/authorize?request_uri=urn%3Aexample%3Arequest&identitystore_id=d-example",
  ])(
    "shows the manual URL and code while AWS waits for approval (%s)",
    async (url) => {
      const code = "AB12-CD34";
      await fakeAws(
        `printf '%s\\n' 'Please visit the following URL:' '' '${url}'
printf '%s\\n' '' 'Then enter the code:' '' '${code}'
printf '%s\\n' '' 'Alternatively, you may visit the following URL which will autofill the code upon loading:'
printf '%s\\n' 'https://device.sso.eu-west-1.amazonaws.com/?user_code=${code}'
exec /bin/sleep 30\n`,
      );
      const started = await app.inject({ method: "POST", url: loginEndpoint });
      expect(started.statusCode, started.body).toBe(200);
      await vi.waitFor(async () => {
        const status = await app.inject({ method: "GET", url: endpoint });
        expect(status.headers["cache-control"]).toBe("no-store");
        expect(status.json()).toMatchObject({
          pending: true,
          challenge: { url, code },
        });
      });
    },
  );

  it("reports a failure before AWS returns a sign-in code", async () => {
    await fakeAws("exit 1\n");
    const started = await app.inject({ method: "POST", url: loginEndpoint });
    expect(started.statusCode, started.body).toBe(200);
    await vi.waitFor(async () => {
      const status = await app.inject({ method: "GET", url: endpoint });
      expect(status.json()).toMatchObject({
        pending: false,
        problem: expect.stringContaining("could not get a sign-in code"),
      });
    });
  });
});

describe("AWS SSO settings URL validation", () => {
  it.each([
    "https://my-company.awsapps.com/start",
    "https://my-company.awsapps.com.cn/start",
    "https://identitycenter.amazonaws.com/ssoins-111111h2222j33pp",
    "https://ssoins-1234567890abcdef.portal.eu-west-1.app.aws",
    "https://ssoins-111111h2222j33pp.portal.eu-west-1.app.aws",
    "https://ssoins-1234567890abcdef.eu-west-1.portal.amazonaws.com",
    "https://ssoins-111111h2222j33pp.eu-west-1.portal.amazonaws.com",
  ])("saves the supported AWS URL %s", async (startUrl) => {
    const payload = { ...settings, startUrl };
    const result = await app.inject({ method: "PUT", url: endpoint, payload });
    expect(result.statusCode, result.body).toBe(200);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO aws_connections"),
      [project, payload],
    );
  });

  it.each([
    "https://ssoins-111111h2222j33pp.portal.eu-west-1.app.aws.example.com",
    "https://ssoins-111111h2222j33pp.eu-west-1.portal.amazonaws.com.example.com",
    "https://example.com/ssoins-111111h2222j33pp.eu-west-1.portal.amazonaws.com",
    "http://ssoins-111111h2222j33pp.eu-west-1.portal.amazonaws.com",
    "https://user:password@ssoins-111111h2222j33pp.eu-west-1.portal.amazonaws.com",
    "https://ssoins-111111h2222j33pp.eu-west-1.portal.amazonaws.com:8443",
    "https://ssoins-111111h2222j33pp.eu-west-1.portal.amazonaws.com?redirect=example.com",
    "https://ssoins-111111h2222j33pp.eu-west-1.portal.amazonaws.com#fragment",
  ])("rejects the unsupported URL %s without saving it", async (startUrl) => {
    const result = await app.inject({
      method: "PUT",
      url: endpoint,
      payload: { ...settings, startUrl },
    });
    expect(result.statusCode, result.body).toBe(400);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(
      "SELECT 1 FROM projects WHERE id=$1",
      [project],
    );
  });
});
