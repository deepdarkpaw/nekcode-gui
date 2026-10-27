import { PassThrough } from "node:stream";
import { Emitter } from "@zcode/rpc";
import { describe, expect, it } from "vitest";
import type { IRemoteBackend, StdioStream } from "./backend.js";
import {
  acquireRemoteDeployLock,
  buildRemoteDeployLockScript,
  REMOTE_DEPLOY_LOCK_DIR,
} from "./remoteDeployLock.js";

function lockBackend() {
  const releases: string[] = [];
  const backend = {
    exec: async (command: string) => {
      const owner = command.match(/holder-([a-f0-9-]+)\.sh/u)?.[1] ?? "unknown";
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const close = new Emitter<number>();
      stdin.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes(`zcode-deploy-lock-release:${owner}`)) {
          releases.push(owner);
          close.fire(0);
        }
      });
      const stream: StdioStream = { stdin, stdout, stderr, onClose: close.event };
      setTimeout(() => stdout.end(`zcode-deploy-lock-acquired:${owner}\n`), 0);
      return stream;
    },
  } as unknown as IRemoteBackend;
  return { backend, releases };
}

describe("remote deployment lock", () => {
  it("uses atomic mkdir, metadata, ten-minute stale takeover, and a finally-safe release", async () => {
    const script = buildRemoteDeployLockScript(REMOTE_DEPLOY_LOCK_DIR, "owner-token");
    expect(script).toContain('mkdir "$lock_dir"');
    expect(script).toContain('"$lock_dir/pid"');
    expect(script).toContain('"$lock_dir/hostname"');
    expect(script).toContain('"$lock_dir/timestamp"');
    expect(script).toContain("-ge 600");

    const { backend, releases } = lockBackend();
    const first = await acquireRemoteDeployLock(backend, {
      ownerToken: "11111111-1111-4111-8111-111111111111",
    });
    const second = await acquireRemoteDeployLock(backend, {
      ownerToken: "22222222-2222-4222-8222-222222222222",
    });
    try {
      expect(first.ownerToken).not.toBe(second.ownerToken);
    } finally {
      await Promise.all([first.release(), second.release()]);
    }
    expect(releases).toHaveLength(2);
  });
});
