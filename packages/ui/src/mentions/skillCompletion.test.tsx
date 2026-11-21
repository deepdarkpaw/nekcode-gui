// @vitest-environment happy-dom
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
} from "lexical";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SlashCommandPlugin } from "@/SlashCommandPlugin.js";
import { MentionPlugin } from "./MentionPlugin.js";
import { PromptMentionNode } from "./nodes/PromptMentionNode.js";
import { $getPromptMarkdown } from "./promptSerialization.js";
import { parseMentionMarkdown } from "./mentionMarkdown.js";
import { getMentionPanelGroupOrder } from "./mentionPanelRouting.js";
import type { MentionPanelSection } from "./components/MentionPanel.js";

const runtime = vi.hoisted(() => {
  const getSkillReferenceCatalog = vi.fn();
  return {
    getSkillReferenceCatalog,
    resolution: {
      rpcReady: true,
      remoteSessionId: undefined as string | undefined,
      services: {
        zcodeAgentService: {
          getSkillReferenceCatalog,
          onAgentRuntimeRestarted: () => ({ dispose() {} }),
        },
      },
    },
    files: { items: [], loading: false, error: null, title: "Files", emptyText: "No files" },
    sessions: {
      items: [],
      loading: false,
      error: null,
      title: "Sessions",
      emptyText: "No sessions",
    },
  };
});
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => runtime.resolution,
}));
vi.mock("./providers/fileMentionProvider.js", () => ({
  useFileMentionProvider: () => runtime.files,
}));
vi.mock("./providers/sessionsMentionProvider.js", () => ({
  useSessionsMentionProvider: () => runtime.sessions,
}));
// Only replace viewport virtualization: the real plugins, catalog hook, filtering, keys and nodes run below.
vi.mock("./components/MentionPanel.js", () => ({
  MentionPanel: ({
    sections,
    onSelect,
  }: {
    sections: MentionPanelSection[];
    onSelect: (index: number) => void;
  }) => {
    let index = 0;
    return (
      <div>
        {sections.map((section) => (
          <div key={section.id}>
            {section.errorText ? <p role="alert">{section.errorText}</p> : null}
            {section.options.map((option) => {
              const optionIndex = index++;
              return (
                <button
                  key={option.id}
                  role="option"
                  data-option-id={option.id}
                  onClick={() => onSelect(optionIndex)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  },
}));

const skills: ZCodeSkillReferenceCatalogEntry[] = [
  {
    id: "nek:galanalyzer",
    name: "galanalyzer",
    description: "Visual novel analysis",
    path: "C:/Users/test/.nek/agent/skills/galanalyzer/SKILL.md",
    scope: "user",
    enabled: true,
  },
  {
    id: "nek:pdf",
    name: "pdf",
    description: "PDF documents",
    path: "/custom/pdf/SKILL.md",
    scope: "user",
    enabled: true,
  },
];
let editor: LexicalEditor;

function EditorCapture() {
  const [current] = useLexicalComposerContext();
  useEffect(() => {
    editor = current;
  }, [current]);
  return null;
}
function mount(sessionId: string | null = "session-1") {
  return render(
    <ZCodeIntlProvider initialLocale="en-US">
      <LexicalComposer
        initialConfig={{
          namespace: "skill-completion",
          nodes: [PromptMentionNode],
          onError: (error) => {
            throw error;
          },
        }}
      >
        <PlainTextPlugin
          contentEditable={<ContentEditable aria-label="Prompt" />}
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <EditorCapture />
        <SlashCommandPlugin
          workspacePath="/workspace"
          sessionId={sessionId}
          container={document.body}
        />
        <MentionPlugin
          workspacePath="/workspace"
          provider={ZCODE_AGENT_PROVIDER}
          container={document.body}
        />
      </LexicalComposer>
    </ZCodeIntlProvider>,
  );
}
async function typeText(text: string) {
  await act(async () => {
    editor.update(
      () => {
        $getRoot().clear();
        for (const line of text.split("\n\n")) {
          const node = $createTextNode(line);
          $getRoot().append($createParagraphNode().append(node));
          node.selectEnd();
        }
      },
      { discrete: true },
    );
  });
}
function markdown() {
  return editor.getEditorState().read(() => $getPromptMarkdown());
}

beforeEach(() => {
  runtime.getSkillReferenceCatalog.mockReset().mockResolvedValue({ authority: "session", skills });
  runtime.resolution.remoteSessionId = undefined;
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("nek skill completion wiring", () => {
  it.each(["Enter", "Tab"])(
    "SC2/SC3/SC4: /gal accepts with %s and sends the canonical skill without dropping preceding text",
    async (key) => {
      mount();
      await typeText("为什么无法\n\n/gal");
      await screen.findByRole("option", { name: "galanalyzer" });
      expect(runtime.getSkillReferenceCatalog).toHaveBeenCalledWith({
        workspacePath: "/workspace",
        sessionId: "session-1",
        includeSlashCatalog: true,
      });
      await act(async () => {
        editor.dispatchCommand(
          key === "Enter" ? KEY_ENTER_COMMAND : KEY_TAB_COMMAND,
          new KeyboardEvent("keydown", { key }),
        );
      });
      await waitFor(() => expect(markdown()).toBe("为什么无法\n\n@skill:galanalyzer "));
      expect(document.querySelector('[data-mention-category="skills"]')).not.toBeNull();
      const serialized = JSON.stringify(editor.getEditorState().toJSON());
      const restored = editor.parseEditorState(serialized);
      expect(restored.read(() => $getPromptMarkdown())).toBe("为什么无法\n\n@skill:galanalyzer ");
    },
  );

  it("selects a skill from a custom path without sending that path", async () => {
    mount();
    await typeText("/pdf");
    fireEvent.click(await screen.findByRole("option", { name: "pdf" }));
    await waitFor(() => expect(markdown()).toBe("@skill:pdf "));
    expect(parseMentionMarkdown(markdown())).toEqual([
      { type: "skill", label: "pdf" },
      { type: "text", text: " " },
    ]);
  });

  it.each(["@", "@pdf", "@skill:pdf", "$pdf"])(
    "%s does not request or suggest skills",
    async (input) => {
      mount();
      await typeText(input);
      expect(screen.queryByRole("option", { name: "pdf" })).toBeNull();
      expect(runtime.getSkillReferenceCatalog).not.toHaveBeenCalled();
      expect(markdown()).toBe(input);
    },
  );

  it("retains file and conversation routes for @ and #", () => {
    expect(getMentionPanelGroupOrder("@")).toEqual(["files", "sessions"]);
    expect(getMentionPanelGroupOrder("#")).toEqual(["sessions"]);
    expect(getMentionPanelGroupOrder("$")).toEqual([]);
  });

  it("SC1: catalog failures stay visible and reopening explicitly retries rather than showing a false empty list", async () => {
    runtime.getSkillReferenceCatalog.mockRejectedValueOnce(new Error("nek skill discovery failed"));
    mount(null);
    await typeText("/pdf");
    expect((await screen.findByRole("alert")).textContent).toContain("nek skill discovery failed");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await typeText("normal text");
    await typeText("/pdf");
    await screen.findByRole("option", { name: "pdf" });
    expect(runtime.getSkillReferenceCatalog).toHaveBeenCalledTimes(2);
    expect(runtime.getSkillReferenceCatalog).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      includeSlashCatalog: true,
    });
  });
});
