import { afterEach, describe, expect, it, vi } from "vitest";
import { Duplex } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "../src/server/config";
import { docker, launch, type Running } from "../src/server/runtime";

function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value) + "\n");
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
describe("runtime output lifecycle with an isolated Docker fixture", () => {
  let root: string;
  const originalData = config.data;
  afterEach(async () => {
    vi.restoreAllMocks();
    config.data = originalData;
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    root = await mkdtemp(path.join(os.tmpdir(), "workspace-runtime-fixture-"));
    config.data = root;
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    let exit!: () => void;
    const waiting = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const container = {
      id: "synthetic-container",
      modem: {
        dial: vi.fn((options: any, callback: any) => {
          expect(options.file).toEqual(Buffer.alloc(0));
          expect(options.options.stdin).toBe(true);
          callback(null, stream);
        }),
      },
      start: vi.fn(async () => {}),
      wait: vi.fn(() => waiting),
      stop: vi.fn(async () => {
        exit();
      }),
      remove: vi.fn(async () => {}),
    };
    vi.spyOn(docker, "createContainer").mockResolvedValue(container as any);
    return { stream, container, exit };
  }
  it("allows a completion handler to await stop without deadlocking or double stopping", async () => {
    const { stream, container } = await fixture();
    let running!: Running, completed!: () => void;
    const done = new Promise<void>((resolve) => {
      completed = resolve;
    });
    running = await launch(null, "fixture-account", async (event) => {
      if (event.type === "completed") {
        await running.stop();
        completed();
      }
    });
    stream.push(frame({ type: "completed" }));
    await done;
    await running.stop();
    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(stream.destroyed).toBe(true);
  }, 2000);
  it("stops and removes a runner after an oversized event before reporting failure", async () => {
    const { stream, container } = await fixture();
    let failed!: (e: any) => void;
    const failure = new Promise<any>((resolve) => {
      failed = resolve;
    });
    await launch(null, "fixture-account", (event) => {
      if (event.type === "failed") failed(event);
    });
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(2 * 1024 * 1024, 4);
    stream.push(header);
    expect((await failure).error).toContain("oversized");
    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(stream.destroyed).toBe(true);
  }, 2000);
  it("delivers the final output before the container exit event", async () => {
    const { stream, exit } = await fixture();
    const events: string[] = [];
    let release!: () => void, exited!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const running = await launch(null, "fixture-account", async (event) => {
      if (event.type === "delta") await gate;
      events.push(event.type);
      if (event.type === "exit") exited();
    });
    stream.push(frame({ type: "delta", text: "last" }));
    stream.push(null);
    exit();
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([]);
    release();
    await done;
    expect(events).toEqual(["delta", "exit"]);
    await running.stop();
  }, 2000);
});
