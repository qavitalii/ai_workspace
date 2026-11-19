import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";
import { skillRoutes } from "../src/server/skills";

vi.mock("../src/server/db", () => ({
  db: { query: vi.fn(async () => ({ rows: [] })) },
}));
const app = Fastify({ bodyLimit: 24 * 1024 * 1024 });
await app.register(multipart);
skillRoutes(app);
afterAll(() => app.close());

type Entry = { path: string; text?: string; size?: number; symlink?: boolean };
function archive(entries: Entry[]) {
  return execFileSync(
    "python3",
    [
      "-I",
      "-c",
      `
import io, json, stat, sys, zipfile
out = io.BytesIO()
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for entry in json.load(sys.stdin):
        item = zipfile.ZipInfo(entry['path'])
        item.compress_type = zipfile.ZIP_DEFLATED
        if entry.get('symlink'):
            item.create_system = 3
            item.external_attr = (stat.S_IFLNK | 0o777) << 16
        z.writestr(item, b'x' * entry['size'] if 'size' in entry else entry.get('text', '').encode())
sys.stdout.buffer.write(out.getvalue())
`,
    ],
    { input: JSON.stringify(entries), maxBuffer: 24 * 1024 * 1024 },
  );
}
async function preview(entries: Entry[]) {
  const boundary = "skill-review-tests";
  return app.inject({
    method: "POST",
    url: "/api/skills/preview",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="skills.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      archive(entries),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}
const skill = { path: "demo/SKILL.md", text: "# Demo" };

describe("skill YAML frontmatter", () => {
  it.each([
    ['description: "Deploy: safely"', "Deploy: safely"],
    [
      "description: >\n  Deploy safely\n  after review.",
      "Deploy safely after review.",
    ],
    ["description: |\n  First line\n  Second line", "First line\nSecond line"],
    ["name: demo", ""],
  ])("reads %s", async (frontmatter, expected) => {
    const result = await preview([
      {
        ...skill,
        text: `---\n${frontmatter}\n---\n# Demo\ndescription: not metadata`,
      },
    ]);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().skills[0].description).toBe(expected);
  });
  it("does not read descriptions from the body without frontmatter", async () => {
    const result = await preview([
      { ...skill, text: "# Demo\ndescription: body only" },
    ]);
    expect(result.json().skills[0].description).toBe("");
  });
  it.each([
    "---\ndescription: [not, text]\n---\nBody",
    "---\ndescription: [broken\n---\nBody",
    "---\ndescription: first\ndescription: second\n---\nBody",
    "---\nvalue: &value [*value]\ndescription: *value\n---\nBody",
    "---\ndescription: unclosed",
  ])("rejects invalid or non-scalar metadata", async (text) => {
    expect((await preview([{ ...skill, text }])).statusCode).toBe(400);
  });
});

describe("untrusted skill ZIPs", () => {
  it.each([
    "../escape",
    "/absolute",
    "demo/../escape",
    "demo\\escape",
    "C:/escape",
  ])("rejects path %s", async (path) => {
    expect((await preview([skill, { path, text: "bad" }])).statusCode).toBe(
      400,
    );
  });
  it("rejects symlinks", async () => {
    expect(
      (
        await preview([
          skill,
          { path: "demo/link", text: "/etc/passwd", symlink: true },
        ])
      ).statusCode,
    ).toBe(400);
  });
  it("rejects duplicate paths differing only in case", async () => {
    expect(
      (
        await preview([
          skill,
          { path: "demo/file", text: "one" },
          { path: "demo/FILE", text: "two" },
        ])
      ).statusCode,
    ).toBe(400);
  });
  it("accepts 50 skills and rejects 51", async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      path: `skill-${i}/SKILL.md`,
      text: "# Skill",
    }));
    expect((await preview(entries)).statusCode).toBe(200);
    expect((await preview([...entries, skill])).statusCode).toBe(400);
  });
  it("accepts 500 files and rejects 501", async () => {
    const entries = [
      skill,
      ...Array.from({ length: 499 }, (_, i) => ({
        path: `demo/file-${i}`,
        text: "ok",
      })),
    ];
    expect((await preview(entries)).statusCode).toBe(200);
    expect(
      (await preview([...entries, { path: "demo/overflow" }])).statusCode,
    ).toBe(400);
  });
  it("bounds expanded ZIP data at 20 MB even when it compresses to a few KB", async () => {
    const size = 20 * 1024 * 1024 - Buffer.byteLength(skill.text);
    expect(
      (await preview([skill, { path: "demo/data", size }])).statusCode,
    ).toBe(200);
    expect(
      (await preview([skill, { path: "demo/data", size: size + 1 }]))
        .statusCode,
    ).toBe(400);
  });
});
