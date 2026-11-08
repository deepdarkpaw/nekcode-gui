import assert from "node:assert/strict";
import test from "node:test";
import type { NekStatusQueue, NekStoredAttachment } from "@zcode/shared/nek-protocol";
import { boundNekStatusQueue } from "../src/nek-agent/adapter/nekAgentStatusChannel.js";
import { harness, params } from "./nekSessionHarness.js";

const file: NekStoredAttachment = {
  path: "/remote/.nek/agent/attachments/hash/report.docx",
  fileName: "report.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sizeBytes: 12,
  sha256: "a".repeat(64),
};
const queue: NekStatusQueue = {
  steering: ["plain", "with file"],
  followUp: ["later"],
  inputs: {
    steering: [{ text: "plain" }, { text: "with file", attachments: [file] }],
    followUp: [{ text: "later", attachments: [file] }],
  },
};

test("queue recovery preserves all aligned metadata instead of applying lossy status-preview truncation", () => {
  assert.deepEqual(boundNekStatusQueue(queue), queue);
  const longText = "x".repeat(20_000);
  assert.equal(boundNekStatusQueue({ steering: [longText], followUp: [] }).steering[0], longText);
  assert.throws(
    () => boundNekStatusQueue({ ...queue, steering: ["wrong", "with file"] }),
    /Invalid nek attachment queue text/,
  );
  assert.throws(
    () => boundNekStatusQueue({ ...queue, inputs: { steering: [], followUp: [] } }),
    /Invalid nek attachment queue result/,
  );
});

test("requeue sends each original persistent file on its own steering/follow-up input", async () => {
  const h = harness();
  try {
    await h.adapter.requeueNekQueue({ ...params, queue });
    const sent = h.sessions[0]!.commands.filter(
      (command) => command.type === "steer" || command.type === "follow_up",
    );
    assert.deepEqual(
      sent.map((command) => [command.type, command.message, command.attachments]),
      [
        ["steer", "plain", undefined],
        [
          "steer",
          "with file",
          [{ path: file.path, fileName: file.fileName, mimeType: file.mimeType }],
        ],
        [
          "follow_up",
          "later",
          [{ path: file.path, fileName: file.fileName, mimeType: file.mimeType }],
        ],
      ],
    );
    const binding = await h.adapter.ensureNekSessionBinding(params, params.sessionId);
    await h.adapter.service.clearQueue(binding.sessionKey);
    assert.ok(
      h.sessions[0]!.commands.some(
        (command) => command.type === "clear_queue" && command.includeAttachments === true,
      ),
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("a target without attachment support rejects the whole requeue before sending any plain prefix", async () => {
  const h = harness();
  try {
    await h.adapter.readNekSession(params);
    h.sessions[0]!.process.guiInfo = { ...h.sessions[0]!.process.guiInfo, capabilities: undefined };
    await assert.rejects(h.adapter.requeueNekQueue({ ...params, queue }), /更新远端 nek/);
    assert.equal(
      h.sessions[0]!.commands.filter(
        (command) => command.type === "steer" || command.type === "follow_up",
      ).length,
      0,
    );
  } finally {
    await h.adapter.dispose();
  }
});
