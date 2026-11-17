import { afterEach, describe, expect, it, vi } from "vitest";
import Docker from "dockerode";
import { Duplex } from "node:stream";
import { attachInput } from "../src/server/docker-attach";
import { removeDockerResource } from "../src/server/docker-cleanup";
import { startSshHelper } from "../src/server/ssh-runtime";

vi.mock("../src/server/docker-attach", () => ({ attachInput: vi.fn() }));

const conflict = () =>
  Object.assign(new Error("resource in use"), { statusCode: 409 });
const missing = () =>
  Object.assign(new Error("not found"), { statusCode: 404 });

async function fixture() {
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const container = {
    start: vi.fn(async () => {
      const body = Buffer.from(
        JSON.stringify({ type: "result", result: { ready: true } }) + "\n",
      );
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(body.length, 4);
      stream.push(Buffer.concat([header, body]));
    }),
    wait: vi.fn(() => new Promise(() => {})),
    remove: vi.fn(async () => {}),
  };
  const volume = { remove: vi.fn(async () => {}) };
  vi.spyOn(Docker.prototype, "createVolume").mockResolvedValue({} as any);
  vi.spyOn(Docker.prototype, "getVolume").mockReturnValue(volume as any);
  vi.spyOn(Docker.prototype, "createContainer").mockResolvedValue(
    container as any,
  );
  vi.mocked(attachInput).mockResolvedValue(stream);
  const helper = await startSshHelper(
    { operation: "broker", servers: [] },
    true,
  );
  return { helper, container, volume, stream };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SSH cleanup", () => {
  it("waits for container removal and retries busy volumes while sharing concurrent stops", async () => {
    const { helper, container, volume, stream } = await fixture();
    const order: string[] = [];
    container.remove
      .mockImplementationOnce(async () => {
        order.push("container busy");
        throw conflict();
      })
      .mockImplementationOnce(async () => {
        order.push("container removed");
      });
    volume.remove
      .mockImplementationOnce(async () => {
        order.push("volume busy");
        throw conflict();
      })
      .mockImplementationOnce(async () => {
        order.push("volume removed");
      });
    const stopping = helper.stop();
    expect(helper.stop()).toBe(stopping);
    await stopping;
    expect(order).toEqual([
      "container busy",
      "container removed",
      "volume busy",
      "volume removed",
    ]);
    expect(stream.destroyed).toBe(true);
  });

  it("allows cleanup to be retried after a Docker failure", async () => {
    const { helper, container, volume } = await fixture();
    const unavailable = Object.assign(new Error("Docker unavailable"), {
      statusCode: 503,
    });
    volume.remove.mockRejectedValueOnce(unavailable);
    await expect(helper.stop()).rejects.toBe(unavailable);
    container.remove.mockRejectedValueOnce(missing());
    await helper.stop();
    expect(volume.remove).toHaveBeenCalledTimes(2);
  });

  it("treats resources removed by another lifecycle handler as already cleaned up", async () => {
    await expect(
      removeDockerResource(async () => {
        throw missing();
      }),
    ).resolves.toBeUndefined();
  });

  it("bounds retries and reports a resource that stays busy", async () => {
    vi.useFakeTimers();
    const error = conflict();
    const remove = vi.fn(async () => {
      throw error;
    });
    const rejected = expect(removeDockerResource(remove)).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejected;
    expect(remove).toHaveBeenCalledTimes(51);
  });
});
