import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { IRemoteBackend, StdioStream } from "./backend.js";
import { createCloseEventController } from "./closeEvent.js";
import { expectRemoteAssetCommand, runRemoteAssetCommand } from "./remoteAssetCommand.js";

function commandChannel() {
  const closed = createCloseEventController();
  const stream: StdioStream = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    onClose: closed.event,
    signal: vi.fn(),
  };
  const backend = { exec: vi.fn(async () => stream) } as unknown as IRemoteBackend;
  return { backend, stream, close: closed.fire };
}

describe("remote deployment command framing", () => {
  it("drains past early SSH exit while keeping a bounded copy of command output", async () => {
    const { backend, stream, close } = commandChannel();
    const pending = runRemoteAssetCommand(backend, "probe");
    close(0);
    (stream.stdout as PassThrough).end("x".repeat(32 * 1024));
    (stream.stderr as PassThrough).end("late stderr");
    expect(await pending).toEqual({ code: 0, stdout: "x".repeat(4096), stderr: "late stderr" });
  });

  it("requires a completion frame rather than accepting an empty exit", async () => {
    const { backend, stream, close } = commandChannel();
    const pending = expectRemoteAssetCommand(backend, "set -eu", undefined, "nek-assets-committed");
    close(0);
    (stream.stdout as PassThrough).end();
    (stream.stderr as PassThrough).end();
    await expect(pending).rejects.toThrow("nek-assets-committed");
  });

  it("cancels only the owned channel even when no close event is emitted", async () => {
    const { backend, stream } = commandChannel();
    const controller = new AbortController();
    const pending = runRemoteAssetCommand(backend, "download", controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.signal).toHaveBeenCalledOnce();
    expect(stream.signal).toHaveBeenCalledWith("TERM");
    expect((stream.stdin as PassThrough).writableEnded).toBe(true);
  });
});
