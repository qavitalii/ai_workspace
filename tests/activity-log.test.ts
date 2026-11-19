import { describe, expect, it } from "vitest";
import {
  describeActivity,
  mergeActivityEvents,
  type ActivityEvent,
} from "../src/web/activity-log";

const event = (
  id: string,
  type = "log",
  data: Record<string, unknown> = { text: "output" },
): ActivityEvent => ({ id, type, data });

describe("execution history", () => {
  it("keeps saved history when live updates arrive and deduplicates refreshes", () => {
    expect(
      mergeActivityEvents(
        [event("1"), event("2")],
        [event("2"), event("3")],
      ).map((e) => e.id),
    ).toEqual(["1", "2", "3"]);
  });
  it("orders bigint database IDs exactly and excludes unrelated streaming messages", () => {
    expect(
      mergeActivityEvents(
        [event("9007199254740993"), event("10"), event("9")],
        [event("9007199254740992"), event("11", "delta")],
      ).map((e) => e.id),
    ).toEqual(["9", "10", "9007199254740992", "9007199254740993"]);
  });
  it("recognizes Codex and Claude commands without inventing completion status", () => {
    for (const item of [
      { type: "commandExecution", command: "npm test", status: "inProgress" },
      { type: "tool_use", name: "Bash", input: { command: "npm test" } },
    ]) {
      const description = describeActivity(event("1", "tool", { item }));
      expect(description.title).toBe("Run command");
      expect(description.preview).toBe("npm test");
      expect(JSON.parse(description.body)).toEqual(item);
    }
  });
  it("preserves unknown tool fields in expandable details", () => {
    const item = {
      name: "custom_tool",
      input: { nested: { value: "<script>literal</script>" } },
    };
    expect(
      JSON.parse(describeActivity(event("1", "tool", { item })).body),
    ).toEqual(item);
  });
  it("cleans terminal escapes while preserving multiline output", () => {
    const result = describeActivity(
      event("1", "log", { text: "\u001b[32mPassed\u001b[0m\n  12 tests\n" }),
    );
    expect(result.preview).toBe("Passed");
    expect(result.body).toBe("Passed\n  12 tests\n");
  });
  it("distinguishes warnings from account handoffs", () => {
    expect(
      describeActivity(event("1", "warning", { message: "AWS unavailable" })),
    ).toMatchObject({ kind: "warning", preview: "AWS unavailable" });
    expect(
      describeActivity(
        event("2", "handoff", { message: "Using backup account" }),
      ),
    ).toMatchObject({ kind: "action", title: "Account switched" });
  });
});
