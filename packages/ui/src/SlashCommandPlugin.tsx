/* eslint-disable max-lines -- Lexical slash 插件的 trigger/面板/键盘导航同属一个协议状态机，oxfmt 换行后略超 400 行。 */
/**
 * SlashCommandPlugin — Lexical trigger 面板插件
 *
 * 处理 `/` 面板里的 slash commands 和 subagents：
 * 1. `/` 展示有 GUI 动作的 nek 内置命令、RPC 目录、技能与子智能体
 * 2. 面板通过 portal 渲染到输入区上方的独立挂载层，展开时直接覆盖消息区
 * 3. 支持 Esc 关闭、上下键切换、Enter / Tab 选中，以及跟随输入做模糊搜索
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createPortal } from "react-dom";
import {
  $createTextNode,
  $getRoot,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { parseNekBuiltinSlashCommand } from "@zcode/shared/nek-protocol";
import { useNekSkillReferenceCatalog } from "@/hooks/useNekSkillReferenceCatalog.js";
import { isImeComposing } from "@/lib/imeComposition.js";
import { buildSlashApplyMentionPayload } from "@/lib/slashApplyMentionPayload.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { $createPromptMentionNode } from "./mentions/nodes/PromptMentionNode.js";
import {
  extractActivePromptInputTrigger,
  filterPromptInputSuggestions,
  getActivePromptInputTokenTailLength,
  getBestPromptInputSuggestionIndex,
  getPromptInputTriggerSignature,
  type ActivePromptInputTrigger,
  type PromptInputSuggestionItem,
} from "./lib/promptInputTriggers.js";
import { MentionPanel } from "./mentions/components/MentionPanel.js";
import {
  buildSkillSuggestions,
  buildSubagentSuggestions,
  buildSlashCommandSuggestions,
  getTextAroundCursor,
  isAppSlashCommandSuggestion,
  normalizeSlashCommandValue,
  type SlashCommandPluginProps,
} from "./slashCommandHelpers.js";
import { useSlashCommandMentionPanelSections } from "./slashCommandPanelSections.js";
import { getCurrentTextNodeSelection } from "./mentions/mentionHelpers.js";
import {
  getActivePromptInputTokenReplacementRange,
  reconcileActivePromptInputTokenSnapshot,
  type ActivePromptInputTokenSnapshot,
} from "./mentions/activePromptInputToken.js";
import { shouldSlashPanelProcessUpdate } from "./lib/slashPanelUpdateFilter.js";

export function SlashCommandPlugin({
  workspacePath,
  workspaceIdentity,
  sessionId,
  container,
  disabled = false,
  excludedCommandNames,
  appCommands,
}: SlashCommandPluginProps) {
  const [editor] = useLexicalComposerContext();
  const { intl, locale } = useZCodeIntl();
  const [activeTrigger, setActiveTrigger] = useState<ActivePromptInputTrigger | null>(null);
  const {
    commands,
    agents,
    skills,
    loading: skillsLoading,
    error: skillsError,
  } = useNekSkillReferenceCatalog({
    workspacePath,
    workspaceIdentity,
    sessionId: sessionId ?? null,
    enabled: !disabled && activeTrigger?.trigger === "/",
    includeSlashCatalog: true,
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dismissedSignatureRef = useRef<string | null>(null);
  const activeSignatureRef = useRef<string | null>(null);
  const activeTokenRef = useRef<ActivePromptInputTokenSnapshot | null>(null);
  const commandSuggestions = useMemo(
    () =>
      buildSlashCommandSuggestions(
        commands ?? [],
        appCommands ?? [],
        (name) => intl.formatMessage({ id: `chat.slash.builtin.${name}` }),
        excludedCommandNames,
      ),
    [appCommands, commands, excludedCommandNames, intl],
  );
  const subagentSuggestions = useMemo(() => buildSubagentSuggestions(agents ?? []), [agents]);
  const skillSuggestions = useMemo(
    () =>
      buildSkillSuggestions(
        skills.filter((skill) => skill.enabled),
        locale,
      ),
    [locale, skills],
  );
  const filteredCommandSuggestions = useMemo(
    () => filterPromptInputSuggestions(commandSuggestions, activeTrigger?.query ?? null),
    [commandSuggestions, activeTrigger?.query],
  );
  const filteredSubagentSuggestions = useMemo(
    () => filterPromptInputSuggestions(subagentSuggestions, activeTrigger?.query ?? null),
    [subagentSuggestions, activeTrigger?.query],
  );
  const filteredSkillSuggestions = useMemo(
    () => filterPromptInputSuggestions(skillSuggestions, activeTrigger?.query ?? null),
    [skillSuggestions, activeTrigger?.query],
  );
  const filteredSuggestions = useMemo(
    () => [
      ...filteredCommandSuggestions,
      ...filteredSkillSuggestions,
      ...filteredSubagentSuggestions,
    ],
    [filteredCommandSuggestions, filteredSkillSuggestions, filteredSubagentSuggestions],
  );
  const activeSignature = useMemo(
    () => getPromptInputTriggerSignature(activeTrigger),
    [activeTrigger],
  );
  const isOpen = !disabled && activeTrigger !== null;

  useEffect(() => {
    activeSignatureRef.current = activeSignature;
  }, [activeSignature]);

  useEffect(() => {
    // 面板展示需要保留 commands/subagents 分组顺序，但键盘默认选中不能固定落在第一个分组。
    // 例如 `/rev` 时 command 描述里的弱匹配可能排在 subagent 分组前面，导致无法默认选中最佳 subagent。
    // 这里按统一的模糊评分选择全局最佳项，同时不改变面板的分组展示顺序。
    setSelectedIndex(
      getBestPromptInputSuggestionIndex(filteredSuggestions, activeTrigger?.query ?? null),
    );
  }, [activeSignature, activeTrigger?.query, filteredSuggestions]);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (filteredSuggestions.length === 0) {
        return 0;
      }
      return Math.min(current, filteredSuggestions.length - 1);
    });
  }, [filteredSuggestions.length]);

  useEffect(() => {
    if (!disabled) {
      return;
    }

    setActiveTrigger(null);
    setSelectedIndex(0);
    activeTokenRef.current = null;
  }, [disabled]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState, tags }) => {
      editorState.read(() => {
        // 历史导航回填含 / 的历史条目时，不应重新打开 slash 面板，
        // 否则面板以 COMMAND_PRIORITY_CRITICAL 注册方向键处理器，吞掉后续历史翻阅按键。
        if (!shouldSlashPanelProcessUpdate(tags)) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        if (disabled) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const selectionState = getCurrentTextNodeSelection();
        const cursorText = selectionState ?? getTextAroundCursor();
        if (!cursorText) {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const nextActiveToken = selectionState
          ? reconcileActivePromptInputTokenSnapshot(
              activeTokenRef.current,
              selectionState,
              dirtyElements.size === 0 && dirtyLeaves.size === 0,
            )
          : null;
        const nextActiveTrigger = selectionState
          ? nextActiveToken
          : extractActivePromptInputTrigger(cursorText.textBeforeCursor);
        if (!nextActiveTrigger || nextActiveTrigger.trigger !== "/") {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }
        activeTokenRef.current = nextActiveToken;

        const nextSignature = getPromptInputTriggerSignature(nextActiveTrigger);
        if (
          dismissedSignatureRef.current !== null &&
          dismissedSignatureRef.current !== nextSignature
        ) {
          dismissedSignatureRef.current = null;
        }

        if (dismissedSignatureRef.current === nextSignature) {
          setActiveTrigger(null);
          return;
        }

        setActiveTrigger((current) => {
          if (
            current?.trigger === nextActiveTrigger.trigger &&
            current.query === nextActiveTrigger.query
          ) {
            return current;
          }

          return nextActiveTrigger;
        });
      });
    });
  }, [disabled, editor]);

  const applySuggestion = useCallback(
    (suggestion: PromptInputSuggestionItem) => {
      const isAppCommand = isAppSlashCommandSuggestion(suggestion);
      editor.update(() => {
        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          return;
        }

        const snapshotRange = getActivePromptInputTokenReplacementRange(
          activeTokenRef.current,
          selectionState,
        );
        const activeSlashTrigger = snapshotRange
          ? activeTokenRef.current
          : extractActivePromptInputTrigger(selectionState.textBeforeCursor);
        if (!activeSlashTrigger || activeSlashTrigger.trigger !== "/") {
          return;
        }

        const tokenStart =
          snapshotRange?.start ?? selectionState.cursorOffset - activeSlashTrigger.query.length - 1;
        const tokenEnd =
          snapshotRange?.end ??
          selectionState.cursorOffset +
            getActivePromptInputTokenTailLength(
              activeSlashTrigger,
              selectionState.textAfterCursor,
              suggestion.value,
            );
        selectionState.selection.setTextNodeRange(
          selectionState.node,
          tokenStart,
          selectionState.node,
          tokenEnd,
        );

        if (isAppCommand) {
          // App 层命令"选中即执行"：只移除输入中的 `/xxx` token，不插入 mention、不发送。
          selectionState.selection.removeText();
          return;
        }

        const mentionNode = $createPromptMentionNode(buildSlashApplyMentionPayload(suggestion));
        const trailingWhitespace = $createTextNode(" ");
        selectionState.selection.insertNodes([mentionNode, trailingWhitespace]);
        trailingWhitespace.selectEnd();
      });

      dismissedSignatureRef.current = null;
      activeTokenRef.current = null;
      setActiveTrigger(null);
      setSelectedIndex(0);
      if (isAppCommand) {
        appCommands
          ?.find((command) => normalizeSlashCommandValue(command.value) === suggestion.value)
          ?.run();
        return;
      }
      requestAnimationFrame(() => {
        editor.focus();
      });
    },
    [appCommands, editor],
  );

  const selectSuggestion = useCallback(
    (index: number) => {
      const suggestion = filteredSuggestions[index];
      if (!suggestion) {
        return false;
      }

      applySuggestion(suggestion);
      return true;
    },
    [applySuggestion, filteredSuggestions],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (event && isImeComposing(event)) return false;
        if (filteredSuggestions.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredSuggestions.length - 1));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (event && isImeComposing(event)) return false;
        if (filteredSuggestions.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event && isImeComposing(event)) return false;
        // An exact built-in is ready to submit, not a fuzzy completion to replace.
        const command = parseNekBuiltinSlashCommand($getRoot().getTextContent());
        if (command && command.name === activeTrigger?.query) {
          dismissedSignatureRef.current = activeSignatureRef.current;
          setActiveTrigger(null);
          setSelectedIndex(0);
          return false;
        }
        if (!selectSuggestion(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (event && isImeComposing(event)) return false;
        if (!selectSuggestion(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        if (event && isImeComposing(event)) return false;
        event?.preventDefault();
        event?.stopPropagation();

        // 如果 Esc 关闭后只记 query，不区分 `/` 和 `@`，两个触发器同名查询会互相把面板压住。
        // 这里保存 trigger + query 组合签名，只有当前 token 真正变化后才重新打开，避免一关闭就立刻弹回。
        dismissedSignatureRef.current = activeSignatureRef.current;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        dismissedSignatureRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterDown();
      unregisterUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
      unregisterBlur();
    };
  }, [
    activeTrigger?.query,
    editor,
    filteredSuggestions.length,
    isOpen,
    selectSuggestion,
    selectedIndex,
  ]);

  const panelTitle = intl.formatMessage({ id: "chat.slash.title" });
  const hasActiveQuery = (activeTrigger?.query ?? "").trim().length > 0;
  const panelDescription = hasActiveQuery
    ? ""
    : intl.formatMessage({ id: "chat.slash.searchHint" });

  const panelSections = useSlashCommandMentionPanelSections(
    intl,
    commandSuggestions.length,
    filteredCommandSuggestions,
    filteredSkillSuggestions,
    skillsLoading,
    skillsError,
    filteredSubagentSuggestions,
    skillsLoading,
    null,
  );

  if (!isOpen || !container) {
    return null;
  }

  return createPortal(
    <MentionPanel
      title={panelTitle}
      description={panelDescription}
      trigger="/"
      sections={panelSections}
      emptyText=""
      selectedIndex={selectedIndex}
      hasActiveQuery={hasActiveQuery}
      onSelect={selectSuggestion}
    />,
    container,
  );
}
