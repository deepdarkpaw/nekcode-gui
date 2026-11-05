import assert from "node:assert/strict";
import test from "node:test";
import {
  measureTopicNotificationEnvelopeBytes,
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopicFrameSchema,
  TopicWireFrameAssembler,
  type SessionsIndexTopicFrame,
  type WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { makeTopicWireFrames } from "../src/nek-agent/adapter/frameHelpers.js";
import { entry, harness, params } from "./nekSessionHarness.js";

const subscriptionId = "wire-test";
const metadata = { subscriptionId, fromSeq: 0, toSeq: 1, sentAt: 1 };

test("S3: sessions-index uses the same lossless physical frame budget", () => {
  const frame: SessionsIndexTopicFrame = {
    ...metadata,
    topic: "sessions-index/project",
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: "project",
        logEpoch: "1",
        sessions: Array.from({ length: 2000 }, (_, index) => ({
          sessionId: `session-${index}`,
          workspaceId: "project",
          title: "history".repeat(80),
          phase: "completedSuccess",
          sessionEnded: false,
          hasBackgroundWork: false,
          lastActivityAt: 1,
          createdAt: 1,
        })),
      },
    },
  };
  const wires = makeTopicWireFrames(frame, subscriptionId, 1, "initial");
  assert.ok(wires.length > 1);
  const assembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
  const events = wires.flatMap((wire) => {
    assert.ok(
      measureTopicNotificationEnvelopeBytes(wire).maxBytes <= PROTOCOL_V4_LIMITS.maxFrameBytes,
    );
    return assembler.accept(wire);
  });
  assert.deepEqual(events, [{ kind: "complete", frame, deliveryKind: "initial" }]);
});

test("S3: workspace-config uses the same lossless physical frame budget", () => {
  const frame: WorkspaceConfigTopicFrame = {
    ...metadata,
    topic: "workspace-config/project",
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: "project",
        logEpoch: "1",
        config: {
          configOptions: [],
          slashCommands: Array.from({ length: 2000 }, (_, index) => ({
            name: `command-${index}`,
            description: "description".repeat(50),
          })),
        },
      },
    },
  };
  const wires = makeTopicWireFrames(frame, subscriptionId, 2, "recovery");
  assert.ok(wires.length > 1);
  const assembler = new TopicWireFrameAssembler(workspaceConfigTopicFrameSchema);
  const events = wires.flatMap((wire) => {
    assert.ok(
      measureTopicNotificationEnvelopeBytes(wire).maxBytes <= PROTOCOL_V4_LIMITS.maxFrameBytes,
    );
    return assembler.accept(wire);
  });
  assert.deepEqual(events, [{ kind: "complete", frame, deliveryKind: "recovery" }]);
});

test("S4: an over-limit snapshot rejects subscription instead of acknowledging a missing frame", async () => {
  const h = harness({
    entries: [
      {
        ...entry,
        message: {
          ...entry.message,
          content: "x".repeat(PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes + 1),
        },
      },
    ],
  });
  try {
    await assert.rejects(h.adapter.subscribeConversationV4(params), /proto.frameAssemblyTooLarge/u);
    await assert.rejects(h.adapter.subscribeConversationV4(params), /proto.frameAssemblyTooLarge/u);
  } finally {
    await h.adapter.dispose();
  }
});
