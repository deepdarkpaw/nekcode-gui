// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import { describe, expect, it, vi } from "vitest";
import type {
  NekAskQuestionPayload,
  NekExtensionUiRequest,
  NekInteractionFrame,
} from "@zcode/shared/nek-protocol";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { NekAgentFeedProvider } from "@/nek/feed/nekAgentFeed.js";
import { NekAskQuestionCard } from "./NekAskQuestionCard.js";
import { NekInteractionHost } from "./NekInteractionHost.js";
import { createNekInteractionStore } from "./interactionStore.js";

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale="en-US">{children}</ZCodeIntlProvider>
    </TooltipProvider>
  );
}

function createStore(responses: unknown[] = []) {
  return createNekInteractionStore({
    respond: (_sessionKey, response) => responses.push(response),
    onEffect: () => undefined,
  });
}

const ASK_PAYLOAD: NekAskQuestionPayload = {
  title: "Question",
  questions: [
    {
      id: "q1",
      prompt: "Choose a route",
      allow_multiple: true,
      options: [
        { id: "api", label: "Use API" },
        { id: "cli", label: "Use CLI" },
      ],
    },
  ],
};

const askRequest = (id = "ask-1"): NekExtensionUiRequest => ({
  type: "extension_ui_request",
  id,
  method: "structured",
  kind: "nek.ask_question",
  payload: ASK_PAYLOAD,
});

function enqueueAndRender(request: NekExtensionUiRequest) {
  const responses: unknown[] = [];
  const store = createStore(responses);
  store.getState().enqueueExtensionRequest("session-1", request);
  const rendered = render(<NekInteractionHost sessionKey="session-1" store={store} />, { wrapper });
  return { rendered, responses, store };
}

/** 按动作 id 定位提交按钮（与界面语言无关）。 */
function submitButton(root: ParentNode): HTMLButtonElement {
  const button = root.querySelector('[data-interaction-action="nek.interaction.question.submit"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error("submit button is not rendered");
  return button;
}

describe("Nek interaction views", () => {
  it("renders the four interaction card kinds through the host", () => {
    const cases: Array<[NekExtensionUiRequest, string]> = [
      [askRequest(), "nek-ask-question-card"],
      [
        {
          type: "extension_ui_request",
          id: "plan-1",
          method: "structured",
          kind: "nek.plan_review",
          payload: {
            path: "/workspace/PLAN.md",
            revision: 2,
            name: "Release plan",
            overview: "Ship the release.",
            markdown: "# Release plan",
            todos: [{ id: "todo-1", content: "Run tests" }],
          },
        },
        "nek-plan-review-card",
      ],
      [
        {
          type: "extension_ui_request",
          id: "mode-1",
          method: "structured",
          kind: "nek.switch_mode",
          payload: { from: "agent", to: "plan", explanation: "Review first." },
        },
        "nek-switch-mode-card",
      ],
      [
        {
          type: "extension_ui_request",
          id: "confirm-1",
          method: "confirm",
          title: "Continue",
          message: "Continue with this operation?",
        },
        "nek-extension-confirm-card",
      ],
    ];

    for (const [request, testId] of cases) {
      const { rendered, store } = enqueueAndRender(request);
      expect(screen.getByTestId(testId)).toBeTruthy();
      rendered.unmount();
      store.getState().shutdown();
    }
  });

  it("renders a disabled primary action with its disabled-reason tooltip trigger", () => {
    const { rendered, store } = enqueueAndRender(askRequest());
    const primary = document.querySelector(
      '[data-interaction-action="nek.interaction.question.submit"]',
    );
    expect(primary).toBeInstanceOf(HTMLButtonElement);
    expect((primary as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-slot="disabled-reason-trigger"]')).toBeTruthy();
    rendered.unmount();
    store.getState().shutdown();
  });

  it("clicking the primary action responds through the queue store", async () => {
    const { rendered, responses, store } = enqueueAndRender(askRequest());
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Use API" }));
    });
    const primary = document.querySelector(
      '[data-interaction-action="nek.interaction.question.submit"]',
    );
    expect(primary).not.toBeNull();
    await act(async () => {
      fireEvent.click(primary as HTMLButtonElement);
    });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      id: "ask-1",
      result: { answers: [{ questionId: "q1", selected: ["api"] }] },
    });
    rendered.unmount();
    store.getState().shutdown();
  });

  it("keeps the card open and shows controller errors after a failed response", async () => {
    const onSubmit = vi.fn(() => {
      throw new Error("transport failed");
    });
    render(
      <NekAskQuestionCard payload={ASK_PAYLOAD} onSubmit={onSubmit} onDismiss={() => undefined} />,
      { wrapper },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Use API" }));
    });
    await act(async () => {
      fireEvent.click(submitButton(document));
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("transport failed"),
    );
    expect(screen.getByTestId("nek-ask-question-card")).toBeTruthy();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("answers a fed request through the feed RPC and drops it on a cancel frame", async () => {
    const emitter = new Emitter<NekInteractionFrame>();
    const respondNekInteraction = vi.fn(async () => undefined);
    const service = {
      onDynamicNekInteractionFrame: () => emitter.event,
      respondNekInteraction,
      stopSubagent: vi.fn(),
      getSubagentTranscript: vi.fn(),
      listAgentTypes: vi.fn(),
    };
    const target = { workspacePath: "/workspace" };
    const rendered = render(
      <NekAgentFeedProvider service={service} target={target}>
        <NekInteractionHost sessionKey="session-1" />
      </NekAgentFeedProvider>,
      { wrapper },
    );
    const card = within(rendered.container);

    act(() => {
      emitter.fire({
        kind: "request",
        scope: { ...target, sessionId: "session-1" },
        request: askRequest(),
      });
    });
    await act(async () => {
      fireEvent.click(card.getByRole("checkbox", { name: "Use API" }));
    });
    await act(async () => {
      fireEvent.click(submitButton(rendered.container));
    });
    expect(respondNekInteraction).toHaveBeenCalledWith({
      requestId: "ask-1",
      response: {
        type: "extension_ui_response",
        id: "ask-1",
        result: { answers: [{ questionId: "q1", selected: ["api"] }] },
      },
    });
    await waitFor(() => expect(card.queryByTestId("nek-ask-question-card")).toBeNull());

    act(() => {
      emitter.fire({
        kind: "request",
        scope: { ...target, sessionId: "session-1" },
        request: askRequest("ask-2"),
      });
    });
    expect(card.getByTestId("nek-ask-question-card")).toBeTruthy();
    act(() => {
      emitter.fire({ kind: "cancel", scope: { ...target, sessionId: "session-1" }, id: "ask-2" });
    });
    await waitFor(() => expect(card.queryByTestId("nek-ask-question-card")).toBeNull());
    rendered.unmount();
  });

  it("FF: a notify request reaches the existing toast host", () => {
    const store = createStore();
    const rendered = render(<NekInteractionHost sessionKey="session-1" store={store} />, {
      wrapper,
    });

    act(() => {
      store.getState().handleFireAndForget("session-1", {
        type: "extension_ui_request",
        id: "notify-1",
        method: "notify",
        message: "Plan mode enabled",
        notifyType: "warning",
      });
    });

    expect(vi.mocked(toast)).toHaveBeenCalledWith("Plan mode enabled", { variant: "warning" });
    expect(store.getState().sessions["session-1"]?.effects).toEqual([]);
    rendered.unmount();
    store.getState().shutdown();
  });

  it("00-common §5.2: a host-cancelled request toasts the localized one-shot notice", () => {
    const store = createStore();
    store.getState().enqueue("session-1", {
      type: "extension_ui_request",
      id: "gone",
      method: "input",
      title: "Which file?",
    });
    const rendered = render(<NekInteractionHost sessionKey="session-1" store={store} />, {
      wrapper,
    });

    act(() => {
      store.getState().cancelStaleById("gone");
    });

    expect(vi.mocked(toast)).toHaveBeenCalledWith("The request was cancelled", { variant: "info" });
    rendered.unmount();
    store.getState().shutdown();
  });
});
