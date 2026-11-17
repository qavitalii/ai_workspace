import { buildQuestionAnswers } from "../src/question-answers";
import { it, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunInput } from "../src/shared";

async function run(input: RunInput | { type: "usage"; provider: "codex" }) {
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
      createInterface({ input: proc.stdout }).on("line", (line) => {
        const e = JSON.parse(line);
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
        if (e.type === "completed" || e.type === "limits_read") {
          clearTimeout(timer);
          resolve();
        }
        if (e.type === "failed") {
          clearTimeout(timer);
          reject(new Error(JSON.stringify(events)));
        }
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
  },
  120000,
);
