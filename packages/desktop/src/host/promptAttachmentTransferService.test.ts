import { Emitter } from "@zcode/rpc";
import type { IRemoteBackend, StdioStream } from "@zcode/server/remote";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createRemotePromptAttachmentTransferService } from "./promptAttachmentTransferService.js";

function backend(options: { wait?: Promise<void>; started?: () => void; fail?: boolean } = {}) {
  const commands: string[] = [];
  const uploads: Array<{ local: string; remote: string }> = [];
  return {
    commands,
    uploads,
    api: {
      exec: async (command: string) => {
        commands.push(command);
        const stdout = new PassThrough();
        const close = new Emitter<number>();
        setTimeout(() => {
          stdout.end(command.includes("$HOME") ? "/home/remote-user\n" : "");
          close.fire(0);
        }, 0);
        return {
          stdin: new PassThrough(),
          stdout,
          stderr: new PassThrough(),
          onClose: close.event,
        } satisfies StdioStream;
      },
      upload: async (local: string, remote: string) => {
        uploads.push({ local, remote });
        options.started?.();
        await options.wait;
        if (options.fail) throw new Error("SSH disconnected");
      },
    } as unknown as Pick<IRemoteBackend, "exec" | "upload">,
  };
}

const request = {
  operationId: "upload-1",
  sessionId: "chat-1",
  workspacePath: "/project",
  workspaceIdentity: "ssh://remote-host/project",
  remoteSessionId: "remote-connection-1",
  localPath: "C:\\Users\\tester\\Documents\\报告.docx",
  fileName: "报告.docx",
  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sizeBytes: 1200,
};

describe("Remote SSH attachment lifecycle", () => {
  it("validates actual local file size before uploading, including unknown picker sizes", async () => {
    const remote = backend();
    const service = createRemotePromptAttachmentTransferService(remote.api, {
      statLocalFile: async () => ({ size: 257 * 1024 * 1024, isFile: () => true }),
    });
    await expect(service.stage({ ...request, sizeBytes: 0 })).rejects.toThrow("256 MB");
    expect(remote.uploads).toHaveLength(0);
  });

  it("a cancellation during metadata validation cannot start a stale upload", async () => {
    const remote = backend();
    let finish!: (value: { size: number; isFile(): boolean }) => void;
    const pending = new Promise<{ size: number; isFile(): boolean }>((resolve) => {
      finish = resolve;
    });
    const service = createRemotePromptAttachmentTransferService(remote.api, {
      statLocalFile: () => pending,
    });
    const stage = service.stage(request);
    await service.cancel(request.operationId);
    finish({ size: 1200, isFile: () => true });
    await expect(stage).rejects.toThrow("Remote upload canceled");
    expect(remote.uploads).toHaveLength(0);
  });

  it("uploads Windows files first and only hands POSIX target paths to the send flow", async () => {
    const remote = backend();
    const service = createRemotePromptAttachmentTransferService(remote.api, {
      statLocalFile: async () => ({ size: 1200, isFile: () => true }),
    });
    const staged = await service.stage(request);
    expect(staged.staged).toBe(true);
    expect(remote.uploads).toHaveLength(1);
    expect(remote.uploads[0]?.local).toBe(request.localPath);
    expect(staged.ref).toBe(remote.uploads[0]?.remote);
    expect(staged.ref.startsWith("/home/remote-user/.nek/gui-server/tmp/prompt-attachments/")).toBe(
      true,
    );
    expect(staged.ref).not.toContain("C:");
    expect(remote.commands.filter((command) => command.startsWith("rm -f "))).toHaveLength(0);
    // nek has accepted and made its persistent copy; only then may GUI remove SSH staging.
    await service.adopt(request.operationId);
    const cleanup = remote.commands.filter((command) => command.startsWith("rm -f "));
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toContain(staged.ref);
    expect(cleanup[0]).not.toContain("/.nek/agent/attachments/");
    await service.cleanup(request.operationId);
    expect(remote.commands.filter((command) => command.startsWith("rm -f "))).toHaveLength(1);
  });

  it("keeps same-named files and distinct target identities in separate upload locations", async () => {
    const remote = backend();
    const service = createRemotePromptAttachmentTransferService(remote.api, {
      statLocalFile: async () => ({ size: 1200, isFile: () => true }),
    });
    const first = await service.stage(request);
    const second = await service.stage({
      ...request,
      operationId: "upload-2",
      workspaceIdentity: "ssh://other-host/project",
    });
    expect(first.ref).not.toBe(second.ref);
    await service.cancel("upload-1");
    expect(remote.commands.find((command) => command.startsWith("rm -f "))).toContain(first.ref);
    await service.cancel("upload-2");
  });

  it("fails visibly on SSH upload errors and never returns the Windows path as ready", async () => {
    const remote = backend({ fail: true });
    const service = createRemotePromptAttachmentTransferService(remote.api, {
      statLocalFile: async () => ({ size: 1200, isFile: () => true }),
    });
    await expect(service.stage(request)).rejects.toThrow("远端附件上传失败");
    expect(remote.commands.some((command) => command.startsWith("rm -f "))).toBe(true);
  });

  it("cleans late successful uploads after a scope cancellation instead of returning stale refs", async () => {
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const uploadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const remote = backend({ wait, started });
    const service = createRemotePromptAttachmentTransferService(remote.api, {
      statLocalFile: async () => ({ size: 1200, isFile: () => true }),
    });
    const stage = service.stage(request);
    await uploadStarted;
    await service.cancel(request.operationId);
    release();
    await expect(stage).rejects.toThrow("Remote upload canceled");
    expect(remote.commands.filter((command) => command.startsWith("rm -f "))).toHaveLength(1);
  });
});
