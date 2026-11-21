#!/usr/bin/env node
// Deterministic App Server peer: validates requests without credentials or inference.
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { largeImage } from "./large-image.mjs";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
function imageNotifications() {
  const bytes = largeImage();
  assert.ok(bytes.length > 1024 ** 2);
  const base64 = bytes.toString("base64");
  const complete = (item) =>
    send({ method: "item/completed", params: { item } });
  const generation = { type: "imageGeneration", status: "completed" };
  send({
    method: "item/started",
    params: {
      item: { ...generation, id: "inline", status: "generating", result: "" },
    },
  });
  complete({ ...generation, id: "inline", result: base64 });
  const directory = path.join(
    process.env.CODEX_HOME,
    "generated_images",
    "thread-test",
  );
  mkdirSync(directory, { recursive: true });
  const savedPath = path.join(directory, "ig_fixture.png");
  writeFileSync(savedPath, bytes);
  complete({ ...generation, id: "file", fileId: "file-fixture", savedPath });
  const outside = "/tmp/fixture-private-image.png";
  const symlink = path.join(directory, "ig_outside.png");
  writeFileSync(outside, bytes);
  symlinkSync(outside, symlink);
  complete({
    ...generation,
    id: "unsafe",
    fileId: "file-outside",
    savedPath: symlink,
  });
  complete({
    type: "mcpToolCall",
    id: "mcp-image",
    status: "completed",
    server: "fixture",
    tool: "generate",
    arguments: {},
    result: {
      content: [{ type: "image", mimeType: "image/png", data: base64 }],
      structuredContent: { duplicateImage: base64 },
    },
  });
  send({
    method: "item/agentMessage/delta",
    params: { delta: "Image generation complete." },
  });
}
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
              {
                id: "areas",
                question: "Which areas?",
                multiSelect: true,
                options: [{ label: "Tests" }, { label: "Docs" }],
              },
              { id: "notes", question: "Any notes?" },
            ],
          },
        });
      } else {
        assert.equal(p.collaborationMode.mode, "default");
        send({ id: m.id, result: {} });
        if (
          p.input.some((part) =>
            part.text?.startsWith("Generate a large image"),
          )
        )
          imageNotifications();
        send({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
      }
    } else if (m.id === 701) {
      assert.deepEqual(m.result, {
        answers: {
          design: { answers: ["Simple"] },
          areas: { answers: ["Tests", "Docs"] },
          notes: { answers: ["Keep changes focused"] },
        },
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
