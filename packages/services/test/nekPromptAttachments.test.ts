import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { harness, params, target, sessionId } from "./nekSessionHarness.js";

async function fixture() {
  const root = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "prompt-attachments-"));
  const path = join(dir, "报告 with spaces.docx");
  await writeFile(path, Buffer.from([80, 75, 3, 4, 0, 255]));
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function envelope(type = "sendText", payload: unknown = {}) {
  return {
    commandId: `file-${Math.random()}`,
    clientId: "test",
    sessionId,
    type,
    payload,
    issuedAt: 1,
  };
}

test("ordinary file paths use the same RPC attachment contract for prompt, steer and follow-up", async () => {
  const file = await fixture();
  const h = harness();
  try {
    const attachments = [
      {
        ref: file.path,
        fileName: "original.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: 6,
      },
    ];
    for (const requestedDelivery of [undefined, "guide", "queue"]) {
      const ack = await h.adapter.sendConversationCommandV4({
        ...target,
        envelope: envelope("sendText", { text: "review", attachments, requestedDelivery }),
      });
      assert.equal(ack.status, "accepted");
    }
    const sent = h.sessions[0]!.commands.filter((command) =>
      ["prompt", "steer", "follow_up"].includes(command.type),
    );
    assert.deepEqual(
      sent.map((command) => command.type),
      ["prompt", "steer", "follow_up"],
    );
    for (const command of sent) {
      assert.ok(
        command.type === "prompt" || command.type === "steer" || command.type === "follow_up",
      );
      assert.equal(command.message, "review");
      assert.equal(command.images, undefined);
      assert.deepEqual(command.attachments, [
        { path: file.path, fileName: "original.docx", mimeType: attachments[0]!.mime },
      ]);
    }
  } finally {
    await h.adapter.dispose();
    await file.cleanup();
  }
});

test("new conversation firstInput and legacy send use the same target-local attachment normalization", async () => {
  const file = await fixture();
  for (const kind of ["create", "legacy"] as const) {
    const h = harness();
    try {
      const attachments = [{ ref: file.path, fileName: "notes.txt", mime: "text/plain", bytes: 6 }];
      if (kind === "create") {
        const ack = await h.adapter.sendConversationCommandV4({
          ...target,
          envelope: envelope("createSession", { firstInput: { text: "", attachments } }),
        });
        assert.equal(ack.status, "accepted");
      } else {
        await h.adapter.sendPrompt({
          ...params,
          content: "review",
          attachments: [
            {
              kind: "file",
              filename: "notes.txt",
              mimeType: "text/plain",
              localPath: file.path,
              sizeBytes: 6,
            },
          ],
        });
      }
      const prompt = h.sessions[0]!.commands.find((command) => command.type === "prompt");
      assert.ok(prompt?.type === "prompt");
      assert.deepEqual(prompt.attachments, [
        { path: file.path, fileName: "notes.txt", mimeType: "text/plain" },
      ]);
    } finally {
      await h.adapter.dispose();
    }
  }
  await file.cleanup();
});

test("missing target capability rejects before RPC; files cannot silently disappear on older remote nek", async () => {
  const h = harness();
  try {
    await h.adapter.readNekSession(params);
    h.sessions[0]!.process.guiInfo = { ...h.sessions[0]!.process.guiInfo, capabilities: undefined };
    await assert.rejects(
      h.adapter.sendNekConversationCommandV4({
        target,
        envelope: envelope("sendText", {
          text: "review",
          attachments: [{ ref: "/remote/report.pdf", mime: "application/pdf" }],
        }),
      }),
      /更新远端 nek/,
    );
    assert.ok(!h.sessions[0]!.commands.some((command) => command.type === "prompt"));
  } finally {
    await h.adapter.dispose();
  }
});

test("relative/host-only URI refs and invalid attachment counts are rejected, not turned into prompt text", async () => {
  const h = harness();
  try {
    for (const attachments of [
      [{ ref: "relative/report.pdf", mime: "application/pdf" }],
      [{ ref: "file:///C:/Users/test/report.pdf", mime: "application/pdf" }],
      Array.from({ length: 9 }, () => ({ ref: "/report.pdf", mime: "application/pdf" })),
    ]) {
      await assert.rejects(
        h.adapter.sendNekConversationCommandV4({
          target,
          envelope: envelope("sendText", { text: "review", attachments }),
        }),
      );
    }
    assert.ok(!h.sessions[0]!.commands.some((command) => command.type === "prompt"));
  } finally {
    await h.adapter.dispose();
  }
});
