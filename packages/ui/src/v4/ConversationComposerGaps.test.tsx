// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
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
afterEach(cleanup);

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
