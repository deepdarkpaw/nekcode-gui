import assert from "node:assert/strict";
import test from "node:test";
import type { NekRpcSessionState, NekSessionEntry } from "@zcode/shared/nek-protocol";
import {
  conversationTopicFrameSchema,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";

const state: NekRpcSessionState = {
  sessionId: "restored-session",
  model: {
    provider: "mock",
    id: "mock-model",
    name: "Local Mock Model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:12345/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    reasoning: false,
  },
  thinkingLevel: "off",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: true,
  messageCount: 2,
  pendingMessageCount: 0,
};

const entries: NekSessionEntry[] = [
  {
    type: "model_change",
    id: "model",
    parentId: null,
    timestamp: "2026-11-01T00:00:00.000Z",
    provider: "mock",
    modelId: "mock-model",
  },
  {
    type: "thinking_level_change",
    id: "thinking",
    parentId: "model",
    timestamp: "2026-11-01T00:00:01.000Z",
    thinkingLevel: "off",
  },
];

const selection = {
  providerId: "mock",
  modelId: "mock-model",
  options: { reasoningLevel: "off" },
};

/** The wire snapshot, not renderer-local drafts, must carry the restored session seed. */
test("first restored snapshot carries canonical model selection without a renderer draft", () => {
  const projector = new NekConversationProjector({ sessionId: state.sessionId });
  projector.loadSnapshot({ entries, leafId: "thinking", state });
  const frames: ConversationTopicFrame[] = [];
  projector.subscribe((frame) => frames.push(conversationTopicFrameSchema.parse(frame)));
  const first = frames[0];
  assert.equal(first?.payload.kind, "snapshot");
  assert.ok(first?.payload.kind === "snapshot");
  assert.deepEqual(first.payload.snapshot.config.modelSelection, selection);
  assert.equal(first.payload.snapshot.usage.contextWindow?.maxTokens, 32768);
  projector.dispose();
});

test("entry-only restore projects the persisted selection and leaves unknown options absent", () => {
  const projector = new NekConversationProjector({ sessionId: state.sessionId });
  projector.loadSnapshot({ entries, leafId: "model" });
  assert.deepEqual(projector.snapshot().config.modelSelection, {
    providerId: "mock",
    modelId: "mock-model",
  });
  projector.loadSnapshot({ entries, leafId: "thinking" });
  assert.deepEqual(projector.snapshot().config.modelSelection, selection);
  projector.dispose();
});

test("restore with no known model does not invent a model selection", () => {
  const projector = new NekConversationProjector({ sessionId: state.sessionId });
  projector.loadSnapshot({ entries: [], leafId: null, state: { ...state, model: undefined } });
  assert.equal(projector.snapshot().config.modelSelection, undefined);
  assert.equal(projector.snapshot().config.model, "");
  projector.dispose();
});

/** New subscribers must not receive the seed of an earlier accepted model or thinking level. */
test("snapshots after live model and thinking facts keep canonical selection aligned", () => {
  const projector = new NekConversationProjector({ sessionId: state.sessionId });
  projector.loadSnapshot({ entries, leafId: "thinking", state });
  const expectSelection = (modelId: string, reasoningLevel: string) => {
    const frames: ConversationTopicFrame[] = [];
    const detach = projector.subscribe((frame) => frames.push(frame));
    detach();
    const parsed = conversationTopicFrameSchema.parse(frames[0]);
    assert.ok(parsed.payload.kind === "snapshot");
    const { config } = parsed.payload.snapshot;
    assert.deepEqual(config.modelSelection, {
      providerId: "mock",
      modelId,
      options: { reasoningLevel },
    });
    assert.equal(config.model, modelId);
    assert.equal(config.thought, reasoningLevel);
  };
  projector.applySessionState({ ...state, thinkingLevel: "high" });
  expectSelection("mock-model", "high");
  projector.handleEvent({
    type: "entry_appended",
    entry: {
      ...entries[0],
      type: "model_change",
      id: "next",
      provider: "mock",
      modelId: "next-model",
    },
  });
  expectSelection("next-model", "high");
  projector.handleEvent({ type: "thinking_level_changed", level: "low" });
  expectSelection("next-model", "low");
  projector.handleEvent({
    type: "entry_appended",
    entry: {
      ...entries[1],
      type: "thinking_level_change",
      id: "next-thinking",
      thinkingLevel: "max",
    },
  });
  expectSelection("next-model", "max");
  projector.dispose();
});
