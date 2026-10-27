import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type {
  NekBashResult,
  NekCompactionResult,
  NekMentionTargetInfo,
  NekModel,
  NekSessionStats,
} from "@zcode/shared/nek-protocol";
import type { NekConversationListener, NekMode, NekPromptInput, NekThoughtLevel } from "./types.js";
import {
  abort,
  abortBash,
  bash,
  clearQueue,
  clone,
  compact,
  cycleModel,
  cycleThinkingLevel,
  exportSession,
  fork,
  getCommands,
  getMentionTargets,
  getStats,
  importSession,
  navigateTree,
  reload,
  sendPrompt,
  setEntryLabel,
  setModel,
  setMode,
  setThinkingLevel,
  shareSession,
  type NekAgentCommandContext,
} from "./nekAgentServiceCommands.js";

export interface NekAgentServiceCommandHost {
  commandContext(): NekAgentCommandContext;
  requireRecord(sessionKey: string): {
    projector?: { snapshot(): ConversationSnapshot; subscribe(listener: NekConversationListener): () => void };
    key: string;
  };
  refreshProcessSnapshot(record: unknown): Promise<void>;
}

export interface NekAgentServiceCommandMethods {
  sendPrompt(input: NekPromptInput): Promise<{ disposition: string }>;
  abort(sessionKey: string): Promise<void>;
  bash(input: { sessionKey: string; command: string; excludeFromContext?: boolean }): Promise<NekBashResult>;
  abortBash(sessionKey: string): Promise<void>;
  clearQueue(sessionKey: string): Promise<{ steering: string[]; followUp: string[] }>;
  retrieveQueue(sessionKey: string): Promise<{ steering: string[]; followUp: string[] }>;
  compact(input: { sessionKey: string; instructions?: string }): Promise<NekCompactionResult>;
  setModel(input: { sessionKey: string; provider: string; modelId: string }): Promise<NekModel>;
  cycleModel(sessionKey: string): Promise<unknown>;
  setThinkingLevel(input: { sessionKey: string; level: NekThoughtLevel }): Promise<void>;
  setThoughtLevel(input: { sessionKey: string; level: NekThoughtLevel }): Promise<void>;
  cycleThinkingLevel(sessionKey: string): Promise<unknown>;
  cycleThoughtLevel(sessionKey: string): Promise<unknown>;
  getStats(sessionKey: string): Promise<NekSessionStats>;
  reload(sessionKey: string): Promise<unknown>;
  setMode(input: { sessionKey: string; mode: NekMode }): Promise<unknown>;
  getCommands(sessionKey: string): Promise<unknown[]>;
  getMentionTargets(input: { sessionKey?: string; cwd?: string } | string): Promise<NekMentionTargetInfo[]>;
  navigateTree(input: {
    sessionKey: string;
    entryId: string;
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  }): Promise<{ cancelled: boolean; editorText?: string }>;
  setEntryLabel(input: { sessionKey: string; entryId: string; label?: string }): Promise<void>;
  fork(input: { sessionKey: string; entryId: string }): Promise<{ text: string; cancelled: boolean }>;
  clone(sessionKey: string): Promise<{ cancelled: boolean }>;
  exportSession(input: { sessionKey: string; format: "html" | "jsonl"; outputPath?: string }): Promise<{ path: string }>;
  shareSession(sessionKey: string): Promise<{ url: string }>;
  importSession(input: { inputPath: string; cwd: string }): Promise<{ sessionPath: string }>;
  subscribeConversation(sessionKey: string, listener: NekConversationListener): Promise<() => void>;
  conversationSnapshot(sessionKey: string): ConversationSnapshot;
}

export const nekAgentServiceCommandMethods: NekAgentServiceCommandMethods = {
  async sendPrompt(this: NekAgentServiceCommandHost, input) {
    return await sendPrompt(this.commandContext(), input);
  },
  async abort(this: NekAgentServiceCommandHost, sessionKey) {
    await abort(this.commandContext(), sessionKey);
  },
  async bash(this: NekAgentServiceCommandHost, input) {
    return await bash(this.commandContext(), input);
  },
  async abortBash(this: NekAgentServiceCommandHost, sessionKey) {
    await abortBash(this.commandContext(), sessionKey);
  },
  async clearQueue(this: NekAgentServiceCommandHost, sessionKey) {
    return await clearQueue(this.commandContext(), sessionKey);
  },
  async retrieveQueue(this: NekAgentServiceCommandHost, sessionKey) {
    return await clearQueue(this.commandContext(), sessionKey);
  },
  async compact(this: NekAgentServiceCommandHost, input) {
    return await compact(this.commandContext(), input);
  },
  async setModel(this: NekAgentServiceCommandHost, input) {
    return await setModel(this.commandContext(), input);
  },
  async cycleModel(this: NekAgentServiceCommandHost, sessionKey) {
    return await cycleModel(this.commandContext(), sessionKey);
  },
  async setThinkingLevel(this: NekAgentServiceCommandHost, input) {
    await setThinkingLevel(this.commandContext(), input);
  },
  async setThoughtLevel(this: NekAgentServiceCommandHost, input) {
    await setThinkingLevel(this.commandContext(), input);
  },
  async cycleThinkingLevel(this: NekAgentServiceCommandHost, sessionKey) {
    return await cycleThinkingLevel(this.commandContext(), sessionKey);
  },
  async cycleThoughtLevel(this: NekAgentServiceCommandHost, sessionKey) {
    return await cycleThinkingLevel(this.commandContext(), sessionKey);
  },
  async getStats(this: NekAgentServiceCommandHost, sessionKey) {
    return await getStats(this.commandContext(), sessionKey);
  },
  async reload(this: NekAgentServiceCommandHost, sessionKey) {
    return await reload(this.commandContext(), sessionKey);
  },
  async setMode(this: NekAgentServiceCommandHost, input) {
    return await setMode(this.commandContext(), input);
  },
  async getCommands(this: NekAgentServiceCommandHost, sessionKey) {
    return await getCommands(this.commandContext(), sessionKey);
  },
  async getMentionTargets(this: NekAgentServiceCommandHost, input) {
    return await getMentionTargets(this.commandContext(), input);
  },
  async navigateTree(this: NekAgentServiceCommandHost, input) {
    return await navigateTree(this.commandContext(), input);
  },
  async setEntryLabel(this: NekAgentServiceCommandHost, input) {
    await setEntryLabel(this.commandContext(), input);
  },
  async fork(this: NekAgentServiceCommandHost, input) {
    return await fork(this.commandContext(), input);
  },
  async clone(this: NekAgentServiceCommandHost, sessionKey) {
    return await clone(this.commandContext(), sessionKey);
  },
  async exportSession(this: NekAgentServiceCommandHost, input) {
    return await exportSession(this.commandContext(), input);
  },
  async shareSession(this: NekAgentServiceCommandHost, sessionKey) {
    return await shareSession(this.commandContext(), sessionKey);
  },
  async importSession(this: NekAgentServiceCommandHost, input) {
    return await importSession(this.commandContext(), input);
  },
  async subscribeConversation(this: NekAgentServiceCommandHost, sessionKey, listener) {
    const record = this.requireRecord(sessionKey);
    if (!record.projector) await this.refreshProcessSnapshot(record);
    return record.projector!.subscribe(listener);
  },
  conversationSnapshot(this: NekAgentServiceCommandHost, sessionKey) {
    const record = this.requireRecord(sessionKey);
    if (!record.projector) throw new Error(`conversation is not loaded for ${sessionKey}`);
    return record.projector.snapshot();
  },
};
