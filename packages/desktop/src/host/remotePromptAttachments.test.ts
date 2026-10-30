import { Emitter } from "@zcode/rpc";
import type { IRemoteBackend, StdioStream } from "@zcode/server/remote";
import type { ZCodePromptFileAttachment } from "@zcode/shared";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  cleanupRemotePromptAttachment,
  cleanupStaleRemotePromptAttachments,
  materializeRemotePromptAttachments,
} from "./remotePromptAttachments.js";

const REMOTE_HOME = "/home/tester";
/** 远端暂存附件根必须挂在 nek 的远端安装根下，不能再出现旧品牌目录。 */
const REMOTE_ATTACHMENT_ROOT = `${REMOTE_HOME}/.nek/gui-server/tmp/prompt-attachments`;

interface FakeBackendOptions {
  failUpload?: boolean;
}

function createFakeBackend(options: FakeBackendOptions = {}) {
  const commands: string[] = [];
  const uploads: Array<{ localPath: string; remotePath: string }> = [];

  const backend = {
    exec: async (command: string) => {
      commands.push(command);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const close = new Emitter<number>();
      setTimeout(() => {
        stdout.end(command.includes("$HOME") ? `${REMOTE_HOME}\n` : "");
        close.fire(0);
      }, 0);
      const stream: StdioStream = { stdin, stdout, stderr, onClose: close.event };
      return stream;
    },
    upload: async (localPath: string, remotePath: string) => {
      if (options.failUpload === true) {
        throw new Error("upload failed");
      }
      uploads.push({ localPath, remotePath });
    },
  } as unknown as Pick<IRemoteBackend, "exec" | "upload">;

  return { backend, commands, uploads };
}

function fileAttachment(localPath: string): ZCodePromptFileAttachment {
  return {
    kind: "file",
    filename: "notes.md",
    mimeType: "text/markdown",
    sizeBytes: 12,
    localPath,
  };
}

describe("materializeRemotePromptAttachments", () => {
  it("把本机附件暂存到远端安装根的 tmp 目录，并改写 content 与 localPath", async () => {
    const { backend, uploads } = createFakeBackend();

    const result = await materializeRemotePromptAttachments(
      {
        content: "请看 /local/notes.md",
        traceId: "trace-1",
        attachments: [fileAttachment("/local/notes.md")],
      },
      { backend },
    );

    expect(uploads).toHaveLength(1);
    const remotePath = uploads[0]?.remotePath ?? "";
    expect(remotePath.startsWith(`${REMOTE_ATTACHMENT_ROOT}/trace-1/`)).toBe(true);
    expect(remotePath.endsWith("-notes.md")).toBe(true);
    expect(remotePath).not.toContain(".zcodium");
    expect(result.uploadedCount).toBe(1);
    expect(result.content).toBe(`请看 ${remotePath}`);
    expect(result.attachments?.[0]?.localPath).toBe(remotePath);
  });

  it("上传失败时清理范围仍限制在远端暂存根内", async () => {
    const { backend, commands } = createFakeBackend({ failUpload: true });

    await expect(
      materializeRemotePromptAttachments(
        {
          content: "",
          traceId: "trace-2",
          attachments: [fileAttachment("/local/notes.md")],
        },
        { backend },
      ),
    ).rejects.toThrow("远端附件上传失败：notes.md");

    const cleanup = commands.find((command) => command.startsWith("rm -f "));
    expect(cleanup).toContain(`${REMOTE_ATTACHMENT_ROOT}/trace-2/`);
  });
});

describe("cleanupRemotePromptAttachment", () => {
  it("拒绝删除远端暂存根之外的路径", async () => {
    const { backend, commands } = createFakeBackend();

    await cleanupRemotePromptAttachment(backend, `${REMOTE_HOME}/.nek/gui-server/node`);

    expect(commands.some((command) => command.startsWith("rm -f "))).toBe(false);
  });

  it("删除远端暂存根内的文件", async () => {
    const { backend, commands } = createFakeBackend();

    await cleanupRemotePromptAttachment(backend, `${REMOTE_ATTACHMENT_ROOT}/trace-3/nonce/01-a.md`);

    const cleanup = commands.find((command) => command.startsWith("rm -f "));
    expect(cleanup).toContain(`${REMOTE_ATTACHMENT_ROOT}/trace-3/nonce/01-a.md`);
  });
});

describe("cleanupStaleRemotePromptAttachments", () => {
  it("按远端暂存根扫过期文件", async () => {
    const { backend, commands } = createFakeBackend();

    await cleanupStaleRemotePromptAttachments(backend);

    const cleanup = commands.find((command) => command.startsWith("if [ -d "));
    expect(cleanup).toContain(REMOTE_ATTACHMENT_ROOT);
    expect(cleanup).toContain("find");
  });
});
