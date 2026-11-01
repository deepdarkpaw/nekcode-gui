// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  ConversationSnapshot,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationRowView } from "./ConversationRowView.js";
import { ConversationTurnGroup } from "./ConversationTurnGroup.js";
import { buildConversationTurnRenderUnits } from "./conversationTurnRenderUnits.js";
import { ConversationLockedBanner } from "./ConversationLockedBanner.js";
import { formatDateTime } from "@/lib/displayFormat.js";
import { useConversationFork } from "./useConversationFork.js";
import { persistV4ComposerDraft, readV4ComposerDraft } from "./composer/composerDraftStore.js";

const context = {
  workspacePath: "/project",
  theme: "light" as const,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};
const row: UserInputRow = {
  kind: "userInput",
  rowId: 2,
  turnId: "turn",
  entityId: "entry:user-2:user",
  productTurnId: "turn",
  createdAt: 1,
  createdAtSeq: 2,
  text: "source prompt",
  origin: "realUser",
  actions: { canFork: true },
};
const snapshot = { sessionId: "source", revision: 7, logEpoch: "nek-1" } as ConversationSnapshot;
const snapshotRef = { current: snapshot };
function wrapper({ children }: PropsWithChildren) {
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>{children}</TooltipProvider>
    </ZCodeIntlProvider>
  );
}
beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("conversation gap UI", () => {
  it("keeps the fork action on user-only turns before any assistant answer", () => {
    const onFork = vi.fn();
    const unit = buildConversationTurnRenderUnits([row], { sessionPhase: "completedSuccess" })[0]!;
    render(<ConversationTurnGroup unit={unit} context={context} onFork={onFork} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Fork before this message" }));
    expect(onFork).toHaveBeenCalledWith({ rowId: 2, entityId: "entry:user-2:user" });
  });
  it("offers fork only on persisted user rows, not assistant rows or uncommitted live users", () => {
    const onFork = vi.fn();
    const view = render(<ConversationRowView row={row} context={context} onFork={onFork} />, {
      wrapper,
    });
    fireEvent.click(screen.getByRole("button", { name: "Fork before this message" }));
    expect(onFork).toHaveBeenCalledWith({ rowId: 2, entityId: "entry:user-2:user" });
    view.rerender(
      <ConversationRowView
        row={{ ...row, entityId: "msg:1:user", actions: undefined }}
        context={context}
        onFork={onFork}
      />,
    );
    expect(screen.queryByRole("button", { name: /Fork/ })).toBeNull();
    view.rerender(
      <ConversationRowView
        row={{ ...row, kind: "assistantText", text: "answer", state: "complete" }}
        context={context}
        onFork={onFork}
      />,
    );
    expect(screen.queryByRole("button", { name: /Fork/ })).toBeNull();
  });

  it("fork backfills the returned child draft before opening it, leaving the source draft untouched", async () => {
    persistV4ComposerDraft("/project", undefined, "source", { text: "unsent source draft" });
    const dispatch = vi.fn(
      async (): Promise<CommandAck> => ({
        commandId: "fork",
        status: "accepted",
        revisionAtDecision: 7,
        result: {
          type: "forkUserMessage",
          sessionId: "child",
          text: "returned by nek, not row text",
        },
      }),
    );
    const onSessionCreated = vi.fn((sessionId: string) => {
      expect(readV4ComposerDraft("/project", undefined, sessionId)?.text).toBe(
        "returned by nek, not row text",
      );
    });
    const onError = vi.fn();
    const { result } = renderHook(
      () =>
        useConversationFork({
          sessionId: "source",
          workspacePath: "/project",
          snapshotRef,
          dispatch,
          onSessionCreated,
          onError,
        }),
      { wrapper },
    );
    act(() => result.current({ rowId: 2, entityId: "entry:user-2:user" }));
    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith("child"));
    expect(dispatch).toHaveBeenCalledWith(
      "forkUserMessage",
      { target: { rowId: 2, entityId: "entry:user-2:user" } },
      "source",
      7,
      "nek-1",
    );
    expect(readV4ComposerDraft("/project", undefined, "source")?.text).toBe("unsent source draft");
    expect(onError).not.toHaveBeenCalled();
  });

  it("a late fork result saves only the child draft and does not hijack a different session", async () => {
    let finish!: (ack: CommandAck) => void;
    const dispatch = vi.fn(
      () =>
        new Promise<CommandAck>((resolve) => {
          finish = resolve;
        }),
    );
    const current = { current: snapshot };
    const navigate = vi.fn();
    const { result } = renderHook(
      () =>
        useConversationFork({
          sessionId: "source",
          workspacePath: "/project",
          snapshotRef: current,
          dispatch,
          onSessionCreated: navigate,
          onError: vi.fn(),
        }),
      { wrapper },
    );
    act(() => result.current({ rowId: 2, entityId: "entry:user-2:user" }));
    current.current = { ...snapshot, sessionId: "another-session" };
    await act(async () =>
      finish({
        commandId: "fork",
        status: "accepted",
        revisionAtDecision: 7,
        result: { type: "forkUserMessage", sessionId: "child", text: "returned text" },
      }),
    );
    expect(readV4ComposerDraft("/project", undefined, "child")?.text).toBe("returned text");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("fork errors enter the command banner channel, while extension cancellation does not navigate", async () => {
    const onError = vi.fn();
    const navigate = vi.fn();
    const dispatch = vi.fn(async (): Promise<CommandAck> => {
      throw new Error("fork RPC failed");
    });
    const { result } = renderHook(
      () =>
        useConversationFork({
          sessionId: "source",
          workspacePath: "/project",
          snapshotRef,
          dispatch,
          onSessionCreated: navigate,
          onError,
        }),
      { wrapper },
    );
    act(() => result.current({ rowId: 2, entityId: "entry:user-2:user" }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "FORK_FAILED", detail: "fork RPC failed" }),
      ),
    );
    dispatch.mockResolvedValueOnce({
      commandId: "cancelled",
      status: "noop",
      revisionAtDecision: 7,
      reasonCode: "guard.forkCancelled",
    });
    await act(async () => result.current({ rowId: 2, entityId: "entry:user-2:user" }));
    expect(navigate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("renders extension identity, handler, message and repeat count through an existing error notice", () => {
    render(
      <ConversationRowView
        row={{
          kind: "timelineMarker",
          rowId: 3,
          turnId: "turn",
          createdAt: 1,
          createdAtSeq: 3,
          lane: "turnTailBoundary",
          marker: {
            type: "extensionError",
            errors: [
              {
                extensionPath: "/extensions/broken.ts",
                event: "tool_call",
                error: "handler exploded",
                count: 12,
              },
            ],
          },
        }}
        context={context}
      />,
      { wrapper },
    );
    expect(
      screen.getByText(/Extension \/extensions\/broken.ts: handler exploded \(tool_call, 12×\)/),
    ).toBeTruthy();
    expect(document.querySelector('[data-error-code="NEK_EXTENSION_ERROR"]')).toBeTruthy();
  });

  it("explains a read-only lock with reported facts and retries without inventing GUI ownership", () => {
    const retry = vi.fn();
    const readOnly = {
      reason: "locked" as const,
      holder: {
        pid: 4242,
        hostname: "dev-box",
        kind: "rpc" as const,
        startedAt: "2026-01-01T02:03:04.000Z",
      },
    };
    const view = render(
      <ConversationLockedBanner readOnly={readOnly} onRetry={retry} retrying={false} />,
      { wrapper },
    );
    expect(screen.getByText(/Read-only: another nek process/)).toBeTruthy();
    // 用户可见时间是本地时区 `YYYY-MM-DD HH:mm`。
    const startedAt = formatDateTime(Date.parse(readOnly.holder.startedAt));
    expect(
      screen.getByText((text) =>
        text.includes(`dev-box, PID 4242, mode rpc, started ${startedAt}`),
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/another GUI|terminal/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry writable access" }));
    expect(retry).toHaveBeenCalledTimes(1);
    view.rerender(
      <ConversationLockedBanner readOnly={{ reason: "locked" }} onRetry={retry} retrying />,
    );
    expect(
      screen.getByRole("button", { name: "Retry writable access" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByText(/PID 4242/)).toBeNull();
    expect(screen.getByText(/Read-only: another nek process/)).toBeTruthy();
  });
});
