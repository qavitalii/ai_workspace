import { it, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunInput } from "../src/shared";

async function run(input: RunInput) {
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
      "ai-workspace-runner:0.1.0",
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
              answers: Object.fromEntries(
                e.questions.map((q: any) => [q.id, { answers: ["Simple"] }]),
              ),
            }) + "\n",
          );
        if (e.type === "completed") {
          clearTimeout(timer);
          resolve();
        }
        if (e.type === "failed") {
          clearTimeout(timer);
          reject(new Error(JSON.stringify(events)));
        }
      });
      proc.stdin.write(JSON.stringify({ type: "start", input }) + "\n");
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
    expect(claude.find((e) => e.type === "commands").commands).toContain(
      "custom-skill",
    );
    expect(claude.find((e) => e.type === "completed").result).toBe(
      "Claude plan complete",
    );
  },
  120000,
);
