import { memo } from "react";
import { Bot, Cable, MessagesSquare, ScrollText, SquareSlash, WandSparkles } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import {
  getPromptMentionVariantClassName,
  PROMPT_MENTION_BASE_CLASS_NAME,
} from "@/mentions/mentionChip.js";
import {
  formatSkillMentionDisplayLabel,
  parseMentionMarkdown,
} from "@/mentions/mentionMarkdown.js";

type V4UserInputMentionPart = ReturnType<typeof parseMentionMarkdown>[number];

function normalizeCommandMentionLabel(label: string): string {
  return label.trim().replace(/^\/+/, "").toLowerCase();
}

function mentionClassName(category: Parameters<typeof getPromptMentionVariantClassName>[0]) {
  return cn(
    "mx-0.5 max-w-full",
    PROMPT_MENTION_BASE_CLASS_NAME,
    // userInput 正文使用 text-ui-base，与 assistant 消息体保持一致。
    "text-ui-base leading-6",
    getPromptMentionVariantClassName(category),
  );
}

function V4UserInputMention({ part }: { part: Exclude<V4UserInputMentionPart, { type: "text" }> }) {
  if (part.type === "file" || part.type === "directory") {
    return (
      <span className={mentionClassName("files")}>
        <FileDisplayInline
          path={part.label}
          options={{
            className: "inline-flex min-w-0 max-w-full items-center gap-1 align-middle",
            iconSize: 16,
            kind: part.type === "directory" ? "directory" : "file",
            fileNameClassName: "truncate text-ui-base leading-6 font-medium text-current",
          }}
        />
      </span>
    );
  }

  if (part.type === "skill") {
    return (
      <span className={mentionClassName("skills")}>
        <WandSparkles aria-hidden="true" className="size-4 shrink-0" />
        {formatSkillMentionDisplayLabel(part.label)}
      </span>
    );
  }

  if (part.type === "session") {
    return (
      <span className={mentionClassName("sessions")}>
        <MessagesSquare aria-hidden="true" className="size-4 shrink-0" />
        {part.label}
      </span>
    );
  }

  if (part.type === "plugin") {
    // 历史消息中的 Plugin 引用仍渲染为 chip：不进 file 分支、不可作外链打开。
    return (
      <span className={mentionClassName("plugins")} data-plugin-mention-id={part.pluginId}>
        <Cable aria-hidden="true" className="size-4 shrink-0" />
        {part.label}
      </span>
    );
  }

  if (part.type === "subagent") {
    return (
      <span className={mentionClassName("subagents")}>
        <Bot aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
        {part.label}
      </span>
    );
  }

  const commandName = normalizeCommandMentionLabel(part.label);
  return (
    <span className={mentionClassName("commands")}>
      {commandName === "compact" ? (
        <ScrollText aria-hidden="true" className="size-4 shrink-0" />
      ) : (
        <SquareSlash aria-hidden="true" className="size-4 shrink-0" />
      )}
      {part.label}
    </span>
  );
}

export const ConversationUserInputContent = memo(function ConversationUserInputContent({
  text,
}: {
  text: string;
}) {
  const parts = parseMentionMarkdown(text);

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return part.text;
        }

        return <V4UserInputMention key={`${part.type}-${index}`} part={part} />;
      })}
    </>
  );
});
