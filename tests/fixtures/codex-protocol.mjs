#!/usr/bin/env node
// Deterministic App Server peer: validates requests without credentials or inference.
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let sandbox;
createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    const m = JSON.parse(line),
      p = m.params;
    if (m.method === "initialized") return;
    if (m.method === "initialize") {
      assert.equal(p.capabilities.experimentalApi, true);
      send({ id: m.id, result: {} });
    } else if (m.method === "account/rateLimits/read") {
      send({
        id: m.id,
        result: {
          rateLimits: {
            primary: {
              usedPercent: 25,
              windowDurationMins: 300,
              resetsAt: 2000000000,
            },
          },
        },
      });
    } else if (["thread/start", "thread/resume"].includes(m.method)) {
      sandbox = p.sandbox;
      send({
        id: m.id,
        result: {
          thread: { id: "thread-test" },
          model: "catalog-model",
          reasoningEffort: "high",
        },
      });
    } else if (m.method === "turn/start") {
      assert.equal(p.collaborationMode.settings.model, "catalog-model");
      assert.equal(p.collaborationMode.settings.developer_instructions, null);
      assert.equal(p.collaborationMode.settings.reasoning_effort, "high");
      if (p.collaborationMode.mode === "plan") {
        assert.equal(sandbox, "read-only");
        send({ id: m.id, result: {} });
        send({
          id: 701,
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-test",
            questions: [
              {
                id: "design",
                header: "Design",
                question: "Choose?",
                options: [{ label: "Simple", description: "Small scope" }],
              },
            ],
          },
        });
      } else {
        assert.equal(p.collaborationMode.mode, "default");
        send({ id: m.id, result: {} });
        send({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
      }
    } else if (m.id === 701) {
      assert.deepEqual(m.result, {
        answers: { design: { answers: ["Simple"] } },
      });
      send({ method: "serverRequest/resolved", params: { requestId: 701 } });
      send({
        method: "item/completed",
        params: { item: { type: "plan", text: "A verified plan" } },
      });
      send({
        method: "turn/completed",
        params: { turn: { status: "completed" } },
      });
    } else if (m.method === "thread/compact/start") {
      send({ id: m.id, result: {} });
      send({
        method: "item/completed",
        params: { item: { type: "contextCompaction" } },
      });
    } else if (m.method === "review/start") {
      assert.equal(p.target.type, "uncommittedChanges");
      send({ id: m.id, result: {} });
      send({
        method: "turn/completed",
        params: { turn: { status: "completed" } },
      });
    } else throw new Error("Unexpected request: " + m.method);
  } catch (e) {
    process.stderr.write(e.stack + "\n");
    process.exit(1);
  }
});
