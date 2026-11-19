#!/usr/bin/env node
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  try {
    const m = JSON.parse(line);
    assert.equal(
      process.argv[process.argv.indexOf("--permission-mode") + 1],
      "plan",
    );
    assert.ok(!process.argv.includes("--dangerously-skip-permissions"));
    const prompt = m.message.content[0].text;
    send({
      type: "system",
      subtype: "init",
      model: "claude-fixture-model",
      session_id: "claude-test",
      slash_commands: ["compact", "context", "custom-skill"],
    });
    send({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.2,
        resetsAt: 2000000000,
      },
    });
    if (prompt === "Plan an install") {
      const settings = JSON.parse(
        process.argv[process.argv.indexOf("--settings") + 1],
      );
      await writeFile(
        path.join(settings.plansDirectory, "install.md"),
        "# Install\nUse ffmpeg.\n",
      );
      const approval = await fetch("http://127.0.0.1:47831/approve", {
        method: "POST",
        body: JSON.stringify({ tool_name: "ExitPlanMode", input: {} }),
      });
      assert.equal((await approval.json()).behavior, "deny");
      send({ type: "result", is_error: false, result: "Plan denied." });
      return;
    }
    assert.equal(prompt, "Plan the task");
    const response = await fetch("http://127.0.0.1:47831/approve", {
      method: "POST",
      body: JSON.stringify({
        tool_name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Choose?",
              header: "Design",
              options: [{ label: "Simple", description: "Small scope" }],
            },
            {
              question: "Which areas?",
              multiSelect: true,
              options: [{ label: "Tests" }, { label: "Docs" }],
            },
            { question: "Any notes?" },
          ],
        },
      }),
    });
    const result = await response.json();
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedInput.answers, {
      "Choose?": "Simple",
      "Which areas?": "Tests, Docs",
      "Any notes?": "Keep changes focused",
    });
    send({ type: "result", is_error: false, result: "Claude plan complete" });
  } catch (e) {
    process.stderr.write(e.stack + "\n");
    process.exit(1);
  }
});
