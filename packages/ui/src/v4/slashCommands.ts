import {
  parseNekBuiltinSlashCommand,
  type NekBuiltinSlashInvocation,
} from "@zcode/shared/nek-protocol";

interface V4PlanShortcut {
  kind: "planShortcut" | "unsupportedPlanShortcut";
  task: string;
}

/** Only non-builtins reach the continuation; a blocked action is not a prompt fallback. */
export function routeNekSlashSubmission<BuiltinResult, PromptResult>(
  text: string,
  runBuiltin: (command: NekBuiltinSlashInvocation) => BuiltinResult,
  submitPrompt: () => PromptResult,
): BuiltinResult | PromptResult {
  const command = parseNekBuiltinSlashCommand(text);
  return command ? runBuiltin(command) : submitPrompt();
}

interface V4VisibleSlashCommandParseOptions {
  contextAttachmentCount?: number;
}

interface SelectionSideSlashCommand {
  command: "side" | "btw";
  text: string;
  displayText: string;
}

interface SelectionSideSlashCommandParseOptions {
  contextAttachmentCount?: number;
  /** CLI catalog 中已经注册的同名命令；同名 CLI 命令优先，不由 App 消费。 */
  enabledCommandNames?: readonly string[];
}

export function parseV4VisibleSlashCommand(
  content: string,
  attachments: readonly unknown[] = [],
  options: V4VisibleSlashCommandParseOptions = {},
): V4PlanShortcut | null {
  const match = /^\/plan(?:\s+([\s\S]*))?$/iu.exec(content.trim());
  if (!match) return null;
  const hasUnsupportedPayload = attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0;
  return {
    kind: hasUnsupportedPayload ? "unsupportedPlanShortcut" : "planShortcut",
    task: match[1]?.trim() ?? "",
  };
}

/**
 * 解析带首条输入的选择副屏命令。
 *
 * 这是 App 层的完整输入消费门：只接受整条文本，且只在没有附件/结构化上下文时
 * 命中。参数只去除首尾空白，保留正文内部的空格和换行，避免改写用户原文。
 */
export function parseSelectionSideSlashCommand(
  content: string,
  attachments: readonly unknown[] = [],
  options: SelectionSideSlashCommandParseOptions = {},
): SelectionSideSlashCommand | null {
  if (attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0) return null;
  const displayText = content.trim();
  const match = /^\/(side|btw)(?:\s+([\s\S]*))?$/i.exec(displayText);
  if (!match) return null;
  const command = match[1]?.toLowerCase() as SelectionSideSlashCommand["command"] | undefined;
  const enabledNames = options.enabledCommandNames;
  if (
    enabledNames &&
    !enabledNames.some((name) => name.trim().replace(/^\/+/, "").toLowerCase() === command)
  ) {
    return null;
  }
  const text = match[2]?.trim() ?? "";
  if (!text || !command) return null;
  return { command, text, displayText };
}
