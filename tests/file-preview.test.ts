import { describe, expect, it } from "vitest";
import { prepareFilePreview } from "../src/web/file-preview";

describe("file preview", () => {
  it("keeps indentation and normalizes Windows line endings", () => {
    expect(prepareFilePreview("first\r\n  second\r\n")).toEqual({
      kind: "text",
      lines: ["first", "  second"],
      truncated: false,
    });
  });
  it("preserves intentional empty lines and an empty file", () => {
    expect(prepareFilePreview("a\n\n")).toEqual({
      kind: "text",
      lines: ["a", ""],
      truncated: false,
    });
    expect(prepareFilePreview("")).toEqual({
      kind: "text",
      lines: [""],
      truncated: false,
    });
  });
  it("offers download instead of displaying binary data", () => {
    expect(prepareFilePreview("PNG\0binary")).toEqual({ kind: "binary" });
  });
  it("bounds rendered lines without falsely truncating the last newline", () => {
    const exact = "line\n".repeat(2000);
    const full = prepareFilePreview(exact);
    const overflow = prepareFilePreview(exact + "extra");
    expect(full.kind === "text" && full.truncated).toBe(false);
    expect(overflow.kind === "text" && overflow.lines).toHaveLength(2000);
    expect(overflow.kind === "text" && overflow.truncated).toBe(true);
  });
  it("leaves HTML and script contents as literal text", () => {
    expect(prepareFilePreview('<script>alert("test")</script>')).toEqual({
      kind: "text",
      lines: ['<script>alert("test")</script>'],
      truncated: false,
    });
  });
});
