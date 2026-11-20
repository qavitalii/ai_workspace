import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { MAX_WORKSPACE_FILE_BYTES } from "../shared.js";
import { rasterImageFormat } from "../raster-image.js";

const workspace = "/workspace";

function decodeImage(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(MAX_WORKSPACE_FILE_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
    value.length % 4 === 1
  )
    return;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length <= MAX_WORKSPACE_FILE_BYTES && rasterImageFormat(bytes))
    return bytes;
}

function readGeneratedFile(value: unknown, home: string, threadId?: string) {
  if (typeof value !== "string") return;
  const source = path.normalize(value);
  const directory = path.dirname(source);
  if (
    directory !== path.join(workspace, "generated_images") &&
    (!threadId ||
      !/^[\w-]+$/.test(threadId) ||
      directory !== path.join(home, "generated_images", threadId))
  )
    return;
  let fd: number | undefined;
  try {
    // Nonblocking prevents a malicious FIFO from stalling the line handler.
    fd = openSync(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < 8 ||
      info.size > MAX_WORKSPACE_FILE_BYTES ||
      realpathSync(`/proc/self/fd/${fd}`) !== source
    )
      return;
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) return;
      offset += count;
    }
    if (rasterImageFormat(bytes)) return bytes;
  } catch {
    // The App Server's path can be absent even when the inline result exists.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function saveImage(bytes: Buffer | undefined) {
  const extension = bytes && rasterImageFormat(bytes);
  if (!bytes || !extension) throw new Error("Invalid generated image");
  const name = `generated-image-${randomUUID()}.${extension}`;
  const file = path.join(workspace, name);
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
  } catch (error) {
    unlinkSync(file);
    throw error;
  } finally {
    closeSync(fd);
  }
  return name;
}

/** Run before serializing the item onto the Workspace event stream. */
export function codexImageItem(
  item: any,
  completed: boolean,
  output: { home: string; threadId?: string } | undefined,
  emit: (event: unknown) => unknown,
) {
  const native = item?.type === "imageGeneration";
  const mcpImages =
    item?.type === "mcpToolCall" && Array.isArray(item.result?.content)
      ? item.result.content.filter((part: any) => part?.type === "image")
      : [];
  if (!native && !mcpImages.length) return item;

  function save(read: () => Buffer | undefined) {
    try {
      emit({ type: "generated_image", name: saveImage(read()) });
    } catch {
      emit({
        type: "warning",
        message: "Workspace could not save an image from this step.",
      });
    }
  }
  if (completed && output) {
    if (
      native &&
      (item.status === "completed" ||
        item.result ||
        item.savedPath ||
        item.fileId)
    )
      save(
        () =>
          readGeneratedFile(item.savedPath, output.home, output.threadId) ??
          decodeImage(item.result),
      );
    for (const image of mcpImages) save(() => decodeImage(image.data));
  }
  // MCP structured content can contain another copy of the same image.
  return {
    type: item.type,
    id: typeof item.id === "string" ? item.id.slice(0, 200) : undefined,
    status:
      typeof item.status === "string" ? item.status.slice(0, 80) : undefined,
    server:
      typeof item.server === "string" ? item.server.slice(0, 200) : undefined,
    tool: typeof item.tool === "string" ? item.tool.slice(0, 200) : undefined,
  };
}
