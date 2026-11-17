import type { AgentEvent } from "../shared.js";

export const MAX_EVENT_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// Consume Docker's multiplexed attach stream directly. Awaiting the handler
// propagates backpressure to the socket instead of queuing promises or lines.
export async function consumeRunnerOutput(
  source: AsyncIterable<Buffer>,
  onEvent: (event: AgentEvent) => void | Promise<void>,
) {
  let header = Buffer.alloc(8),
    headerLength = 0;
  let remaining = 0,
    channel = 0;
  const line = Buffer.alloc(MAX_EVENT_BYTES);
  let length = 0;
  async function stdout(bytes: Buffer) {
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const size = end - start;
      if (length + size > MAX_EVENT_BYTES)
        throw new Error("Runner event exceeds the 1 MiB safety limit.");
      bytes.copy(line, length, start, end);
      length += size;
      if (newline < 0) break;
      if (length) {
        const event = JSON.parse(line.subarray(0, length).toString("utf8"));
        if (!event || typeof event.type !== "string" || event.type.length > 100)
          throw new Error("Invalid runner event.");
        await onEvent(event);
      }
      length = 0;
      start = end + 1;
    }
  }
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!remaining) {
        const size = Math.min(8 - headerLength, chunk.length - offset);
        chunk.copy(header, headerLength, offset, offset + size);
        offset += size;
        headerLength += size;
        if (headerLength < 8) continue;
        channel = header[0];
        remaining = header.readUInt32BE(4);
        headerLength = 0;
        if (
          ![1, 2].includes(channel) ||
          header[1] ||
          header[2] ||
          header[3] ||
          remaining > MAX_EVENT_BYTES
        )
          throw new Error("Invalid or oversized runner output frame.");
        if (!remaining) continue;
      }
      const size = Math.min(remaining, chunk.length - offset);
      const bytes = chunk.subarray(offset, offset + size);
      if (channel === 1) await stdout(bytes);
      else await onEvent({ type: "log", text: bytes.toString("utf8") });
      remaining -= size;
      offset += size;
    }
  }
  if (remaining || headerLength || length)
    throw new Error("Runner output ended with an incomplete event.");
}
