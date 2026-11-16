#!/usr/bin/env node
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  try {
    const m = JSON.parse(line);
    assert.equal(
      process.argv[process.argv.indexOf("--permission-mode") + 1],
      "plan",
    );
    assert.ok(!process.argv.includes("--dangerously-skip-permissions"));
    assert.equal(m.message.content[0].text, "Plan the task");
    send({
      type: "system",
      subtype: "init",
      session_id: "claude-test",
      slash_commands: ["compact", "context", "custom-skill"],
    });
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
          ],
        },
      }),
    });
    const result = await response.json();
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedInput.answers, { "Choose?": "Simple" });
    send({ type: "result", is_error: false, result: "Claude plan complete" });
  } catch (e) {
    process.stderr.write(e.stack + "\n");
    process.exit(1);
  }
});
