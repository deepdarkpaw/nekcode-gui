// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useState, type ComponentProps, type PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AttachmentRef, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  updateComposerAttachmentScope,
  useComposerAttachmentUploadStore,
} from "@/store/composerAttachmentUploadStore.js";
import type { V4ComposerDraft } from "./composer/composerDraftStore.js";
import type { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationComposer } from "./ConversationComposer.js";

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
  useOptionalPlatform: () => null,
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ promptAttachmentTransferService: {} }),
  useOptionalServices: () => null,
}));

/** Substitute only infrastructure and Lexical's shell; draft restoration and admission are real. */
vi.mock("@/prompt-editor/ChatPromptEditor.js", async () => {
  const { useLayoutEffect, useRef, useState } = await import("react");
  return {
    ChatPromptEditor: (props: ComponentProps<typeof ChatPromptEditor>) => {
      const [text, setText] = useState("");
      const ref = useRef(text);
      ref.current = text;
      useLayoutEffect(() => {
        if (!props.inputApiRef) return;
        props.inputApiRef.current = {
          setText,
          getMarkdown: () => ref.current,
          getEditorStateJson: () => undefined,
          focus: () => {},
          focusAtEnd: () => {},
          clear: () => setText(""),
        } as unknown as NonNullable<typeof props.inputApiRef.current>;
      }, [props.inputApiRef]);
      return (
        <>
          <textarea
            aria-label="Editor"
            placeholder={props.placeholder}
            disabled={props.disabled}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              props.onChange?.(event.target.value);
            }}
          />
          <button onClick={() => props.onSubmit(ref.current)}>Invoke editor submit</button>
        </>
      );
    },
  };
});

const snapshot: ConversationSnapshot = {
  protocolVersion: 1,
  sessionId: "child",
  logEpoch: "nek-1",
  seq: 1,
  revision: 1,
  control: {
    phase: "completedSuccess",
    sessionEnded: true,
    canStop: false,
    stopState: "idle",
    stopTargetKind: "unknown",
    activeWorks: [],
    lastError: null,
    apiRetry: null,
  },
  availability: {
    fork: { allowed: true },
    compact: { allowed: true },
    switchModelConfig: { allowed: true },
    setFollowupMode: { allowed: true },
    queueEdit: { allowed: true },
    sendQueuedNow: { allowed: true },
    pauseGoal: { allowed: true },
    resumeGoal: { allowed: true },
  },
  inputRouting: { mode: "startNow" },
  meta: { title: "", titleSource: "default" },
  config: {
    provider: "test",
    model: "test",
    thought: "off",
    thoughtLevels: ["off"],
    followupMode: "queue",
    mode: "agent",
  },
  modelTransition: null,
  usage: {
    contextWindow: null,
    cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
  queue: { items: [], autoDrain: true },
  pendingInteractions: [],
  pendingCommands: [],
  backgroundWorks: [],
  goal: null,
  plan: null,
  workspaceHookAdmission: null,
  rows: { window: [], totalCount: 0, firstRowId: null },
};
function wrapper({ children }: PropsWithChildren) {
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>{children}</TooltipProvider>
    </ZCodeIntlProvider>
  );
}
afterEach(() => {
  cleanup();
  // 附件 store 是模块级单例；测试之间不能留下别的 scope 的附件。
  useComposerAttachmentUploadStore.setState({ scopes: {} });
});

it("restores the fork's returned text into the composer without sending it", async () => {
  const onSendText = vi.fn(async () => "sent" as const);
  render(
    <ConversationComposer
      snapshot={snapshot}
      sessionId="child"
      workspacePath="/project"
      composerDraft={{ text: "returned fork text", updatedAt: 1 }}
      updateComposerContent={vi.fn()}
      replaceComposerDraft={vi.fn()}
      attachmentPut={vi.fn()}
      onSendText={onSendText}
      onStop={vi.fn()}
      onSelectModel={vi.fn()}
      onSelectThought={vi.fn()}
      onSwitchMode={vi.fn()}
      autoFocusEnabled={false}
    />,
    { wrapper },
  );
  await waitFor(() =>
    expect((screen.getByRole("textbox", { name: "Editor" }) as HTMLTextAreaElement).value).toBe(
      "returned fork text",
    ),
  );
  expect(onSendText).not.toHaveBeenCalled();
});

const pasted: AttachmentRef = {
  ref: "/staging/pasted-image.png",
  fileName: "pasted-image.png",
  mime: "image/png",
  bytes: 68,
};

/** 输入框里的附件 chip 来自附件上传 store（编辑器外壳是替身，不渲染附件行）。 */
function pastedChips(): number {
  return Object.values(useComposerAttachmentUploadStore.getState().scopes)
    .flat()
    .filter((item) => item.attachmentRef?.ref === pasted.ref).length;
}

/**
 * 有状态的 Draft owner：合并语义与 SessionPane 相同（useDraftConfigControl.updateComposerContent）。
 * 初始草稿模拟自动保存已经写入的图片引用（用户加图后又打了字）。
 */
function renderWithDraftOwner(
  workspacePath: string,
  onSendText: ComponentProps<typeof ConversationComposer>["onSendText"],
) {
  const owner: { draft?: V4ComposerDraft } = {};
  // 生产中这些回调引用稳定；每次渲染新建会让 scope 恢复 effect 反复重放草稿。
  const replaceComposerDraft = vi.fn();
  const attachmentPut = vi.fn();
  const onStop = vi.fn();
  const onSelect = vi.fn();
  function DraftOwner() {
    const [draft, setDraft] = useState<V4ComposerDraft>({
      text: "describe it",
      attachments: [pasted],
      updatedAt: 1,
    });
    owner.draft = draft;
    const updateComposerContent = useCallback(
      (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention" | "attachments">) =>
        setDraft((current) => ({
          ...current,
          editorStateJson: undefined,
          mention: undefined,
          ...content,
        })),
      [],
    );
    return (
      <ConversationComposer
        snapshot={snapshot}
        sessionId="child"
        workspacePath={workspacePath}
        composerDraft={draft}
        updateComposerContent={updateComposerContent}
        replaceComposerDraft={replaceComposerDraft}
        attachmentPut={attachmentPut}
        onSendText={onSendText}
        onStop={onStop}
        onSelectModel={onSelect}
        onSelectThought={onSelect}
        onSwitchMode={onSelect}
        autoFocusEnabled={false}
      />
    );
  }
  render(<DraftOwner />, { wrapper });
  return owner;
}

it("does not bring a sent image back from the autosaved draft after the send succeeds", async () => {
  const onSendText = vi.fn(
    async (_text: string, _options?: { attachments?: AttachmentRef[] }) => "sent" as const,
  );
  const owner = renderWithDraftOwner("/project-sent-attachment", onSendText);
  await waitFor(() => expect(pastedChips()).toBe(1));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Invoke editor submit" }));
  });
  await waitFor(() => expect(onSendText).toHaveBeenCalledTimes(1));
  expect(onSendText.mock.calls[0]?.[1]).toMatchObject({ attachments: [pasted] });
  // 发送后清空附件不能触发草稿重放；草稿里也不能再留着已经发出的图片。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(owner.draft?.attachments).toBeUndefined();
  expect(pastedChips()).toBe(0);
});

it("drops a removed image from the autosaved draft", async () => {
  const owner = renderWithDraftOwner(
    "/project-removed-attachment",
    vi.fn(async () => "sent" as const),
  );
  await waitFor(() => expect(pastedChips()).toBe(1));
  // 与 chip 的移除按钮相同的效果：附件从输入框的附件 store 里消失。
  act(() => {
    for (const scopeKey of Object.keys(useComposerAttachmentUploadStore.getState().scopes)) {
      updateComposerAttachmentScope(scopeKey, (items) =>
        items.filter((item) => item.attachmentRef?.ref !== pasted.ref),
      );
    }
  });
  // 不再打字：移除本身就要落盘，否则切走再切回会把删掉的图片恢复出来。
  await waitFor(() => expect(owner.draft?.attachments).toBeUndefined(), { timeout: 2_000 });
  expect(owner.draft?.text).toBe("describe it");
  expect(pastedChips()).toBe(0);
});

it("makes the locked composer visibly read-only and blocks even a stale editor submit", async () => {
  const onSendText = vi.fn(async () => "sent" as const);
  const locked: ConversationSnapshot = {
    ...snapshot,
    control: { ...snapshot.control, readOnly: { reason: "locked" } },
    inputRouting: { mode: "reject", reasonCode: "guard.sessionLocked" },
  };
  render(
    <ConversationComposer
      snapshot={locked}
      sessionId="child"
      workspacePath="/project"
      composerDraft={{ text: "unsent draft", updatedAt: 1 }}
      updateComposerContent={vi.fn()}
      replaceComposerDraft={vi.fn()}
      attachmentPut={vi.fn()}
      onSendText={onSendText}
      onStop={vi.fn()}
      onSelectModel={vi.fn()}
      onSelectThought={vi.fn()}
      onSwitchMode={vi.fn()}
      autoFocusEnabled={false}
    />,
    { wrapper },
  );
  await waitFor(() =>
    expect((screen.getByRole("textbox", { name: "Editor" }) as HTMLTextAreaElement).value).toBe(
      "unsent draft",
    ),
  );
  expect(screen.getByRole("textbox").hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByPlaceholderText("Read-only — release the lock in nek, then retry."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Invoke editor submit" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(onSendText).not.toHaveBeenCalled();
});
