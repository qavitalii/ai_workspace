const MAX_PREVIEW_LINES = 2000;

export function prepareFilePreview(
  text: string,
): { kind: "binary" } | { kind: "text"; lines: string[]; truncated: boolean } {
  if (text.includes("\0")) return { kind: "binary" };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return {
    kind: "text",
    lines: lines.slice(0, MAX_PREVIEW_LINES),
    truncated: lines.length > MAX_PREVIEW_LINES,
  };
}
