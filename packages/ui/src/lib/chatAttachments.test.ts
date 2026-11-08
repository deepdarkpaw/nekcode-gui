// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { serializeChatComposerAttachment, type ChatComposerAttachment } from "./chatAttachments.js";
import { OversizedInlineFileAttachmentError } from "./chatAttachmentErrors.js";
import { uploadComposerAttachment } from "@/v4/composer/attachmentUpload.js";

function attachment(file: File): ChatComposerAttachment {
  return { id: "file", file, filename: file.name, mimeType: file.type, sizeBytes: file.size };
}

describe("file attachment serialization", () => {
  it("uploads the complete binary bytes of pathless office files", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4, 255, 0, 123]);
    const serialized = await serializeChatComposerAttachment(
      attachment(
        new File([bytes], "report.docx", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ),
    );
    expect(serialized.kind).toBe("file");
    const put = vi.fn(async () => ({ ref: "/remote/staging/report.docx" }));
    const ref = await uploadComposerAttachment(put, "session", serialized);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ dataBase64: btoa(String.fromCharCode(...bytes)) }),
      undefined,
    );
    expect(ref?.bytes).toBe(bytes.length);
    expect(ref?.ref).toBe("/remote/staging/report.docx");
  });

  it("does not truncate large text to a 64 KB renderer preview", async () => {
    const text = `${"x".repeat(80_000)}\n尾部必须保留`;
    const serialized = await serializeChatComposerAttachment(
      attachment(new File([text], "notes.txt", { type: "text/plain" })),
    );
    expect("textContent" in serialized && serialized.textContent).toBeFalsy();
    const data = "dataBase64" in serialized ? serialized.dataBase64 : undefined;
    expect(data).toBeTruthy();
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(data!), (char) => char.charCodeAt(0)),
    );
    expect(decoded).toBe(text);
  });

  it("rejects oversized pathless files before reading/encoding them", async () => {
    const file = attachment(new File(["small"], "large.xlsx"));
    file.sizeBytes = PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1;
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    try {
      await expect(serializeChatComposerAttachment(file)).rejects.toBeInstanceOf(
        OversizedInlineFileAttachmentError,
      );
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it("keeps native paths byte-free even for large files; nek snapshots them on acceptance", async () => {
    const value: ChatComposerAttachment = {
      id: "native",
      filename: "server.log",
      mimeType: "text/plain",
      sizeBytes: 120 * 1024 * 1024,
      localPath: "C:\\project\\server.log",
    };
    const serialized = await serializeChatComposerAttachment(value);
    expect(serialized).toMatchObject({ kind: "file", localPath: value.localPath });
    const put = vi.fn();
    expect(await uploadComposerAttachment(put, "session", serialized)).toMatchObject({
      ref: value.localPath,
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects metadata-only files instead of pretending to upload an attachment", async () => {
    await expect(
      serializeChatComposerAttachment({
        id: "missing",
        filename: "missing.docx",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
      }),
    ).rejects.toThrow("附件缺少可读取内容");
  });
});
