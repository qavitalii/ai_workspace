import { buildQuestionAnswers } from "../src/question-answers";
import { it, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { consumeRunnerOutput } from "../src/server/runner-output";
import type { RunInput } from "../src/shared";

async function run(
  input: RunInput | { type: "usage"; provider: "codex" },
  outputFolder?: string,
) {
  const name = "workspace-protocol-" + randomUUID();
  const proc = spawn(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--name",
      name,
      "-v",
      `${path.resolve("tests/fixtures")}:/fixtures:ro`,
      ...(outputFolder ? ["-v", `${outputFolder}:/workspace`] : []),
      "--entrypoint",
      "/bin/sh",
      process.env.RUNNER_IMAGE || "ai-workspace-runner:0.1.0",
      "-c",
      "mkdir -p /tmp/test-bin && ln -s /fixtures/codex-protocol.mjs /tmp/test-bin/codex && ln -s /fixtures/claude-protocol.mjs /tmp/test-bin/claude && export PATH=/tmp/test-bin:$PATH && exec node /app/dist/node/runner/main.js",
    ],
    { stdio: "pipe" },
  );
  const events: any[] = [];
  let stderr = "";
  proc.stderr.on("data", (b) => (stderr += b));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Runner timed out: " + stderr)),
        20000,
      );
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("Early exit: " + stderr));
      });
      // The Docker CLI gives us demultiplexed stdout. Frame each chunk so the
      // test exercises the same event size check as the server.
      async function* frames() {
        for await (const chunk of proc.stdout) {
          const header = Buffer.alloc(8);
          header[0] = 1;
          header.writeUInt32BE(chunk.length, 4);
          yield Buffer.concat([header, chunk]);
        }
      }
      void consumeRunnerOutput(frames(), (e) => {
        events.push(e);
        if (e.type === "question")
          proc.stdin.write(
            JSON.stringify({
              type: "answer",
              id: e.id,
              answers: buildQuestionAnswers(
                e.questions,
                Object.fromEntries(
                  e.questions.map((q: any) => [
                    q.id,
                    {
                      selected: q.multiSelect
                        ? ["Tests", "Docs"]
                        : q.options?.length
                          ? ["Simple"]
                          : [],
                      custom: !q.options?.length,
                      text: q.options?.length ? "" : "Keep changes focused",
                    },
                  ]),
                ),
              ),
            }) + "\n",
          );
        if (e.type === "approval" && e.planExit)
          proc.stdin.write(
            JSON.stringify({ type: "approve", id: e.id, allow: false }) + "\n",
          );
        if (e.type === "completed" || e.type === "limits_read") {
          clearTimeout(timer);
          resolve();
        }
        if (e.type === "failed") {
          clearTimeout(timer);
          reject(new Error(JSON.stringify(events)));
        }
      }).catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
      proc.stdin.write(
        JSON.stringify("type" in input ? input : { type: "start", input }) +
          "\n",
      );
    });
    return events;
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {}
    proc.kill();
  }
}

it.skipIf(process.env.DOCKER_TESTS !== "1")(
  "saves large inline, file-backed, and MCP images before the job completes",
  async () => {
    const mount = await mkdtemp(path.join(tmpdir(), "workspace-images-"));
    try {
      await chmod(mount, 0o777);
      const events = await run(
        {
          provider: "codex",
          prompt: "Generate a large image",
          autonomous: true,
          attachments: [],
        },
        mount,
      );
      const names = events
        .filter((e) => e.type === "generated_image")
        .map((e) => e.name);
      expect(names).toHaveLength(3);
      expect(await readdir(mount)).toEqual([...names].sort());
      const bytes = await Promise.all(
        names.map((name) => readFile(path.join(mount, name))),
      );
      expect(bytes[0].length).toBeGreaterThan(1024 ** 2);
      expect(bytes[0].subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(bytes[1].equals(bytes[0]) && bytes[2].equals(bytes[0])).toBe(true);
      expect(events.filter((e) => e.type === "warning")).toHaveLength(1);
      expect(
        events.some(
          (e) => e.type === "delta" && e.text === "Image generation complete.",
        ),
      ).toBe(true);
      expect(events.at(-1)?.type).toBe("completed");
    } finally {
      await rm(mount, { recursive: true, force: true });
    }
  },
  30000,
);
it.skipIf(process.env.DOCKER_TESTS !== "1")(
  "bridges native plans, questions, execution mode, compaction and review without inference",
  async () => {
    const usage = await run({ type: "usage", provider: "codex" });
    expect(
      usage.find((e) => e.type === "limits_read").limits.rateLimits.primary
        .usedPercent,
    ).toBe(25);
    const base: RunInput = {
      provider: "codex",
      prompt: "Plan the task",
      autonomous: true,
      attachments: [],
    };
    const plan = await run({ ...base, mode: "plan" });
    expect(
      plan.some((e) => e.type === "delta" && e.text.includes("verified plan")),
    ).toBe(true);
    expect(plan.some((e) => e.type === "request_resolved")).toBe(true);
    expect(plan.find((e) => e.type === "model")).toMatchObject({
      model: "catalog-model",
      effort: "high",
    });
    await run({ ...base, mode: "default", sessionId: "thread-test" });
    const compact = await run({
      ...base,
      operation: "compact",
      sessionId: "thread-test",
    });
    expect(compact.find((e) => e.type === "completed").result).toContain(
      "compacted",
    );
    await run({ ...base, operation: "review", prompt: "" });
    const claude = await run({ ...base, provider: "claude", mode: "plan" });
    expect(claude.find((e) => e.type === "model").model).toBe(
      "claude-fixture-model",
    );
    expect(claude.find((e) => e.type === "limits").limits.utilization).toBe(
      0.2,
    );
    expect(claude.find((e) => e.type === "commands").commands).toContain(
      "custom-skill",
    );
    expect(claude.find((e) => e.type === "completed").result).toBe(
      "Claude plan complete",
    );
    const exitPlan = await run({
      ...base,
      provider: "claude",
      mode: "plan",
      prompt: "Plan an install",
    });
    expect(exitPlan.find((e) => e.type === "approval")).toMatchObject({
      planExit: true,
      details: "# Install\nUse ffmpeg.",
    });
  },
  120000,
);
