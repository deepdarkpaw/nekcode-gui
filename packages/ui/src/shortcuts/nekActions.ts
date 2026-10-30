/**
 * nek 动作快捷键表（交互规范 §7.7）。
 *
 * - 动作 id 与 nek（`packages/coding-agent/src/core/keybindings.ts`）同名动作一致，
 *   便于导入用户的 `keybindings.json`；nek 没有的桌面动作使用 `gui.*` 前缀；
 * - 绑定串沿用 ZCode 内核格式（shared/shortcutCommands.ts），另支持 Escape/Tab/Space/Backspace；
 * - 桌面端用 CmdOrCtrl（Windows/Linux 为 Ctrl，macOS 为 ⌘）代替终端里的 Ctrl；
 *   与 nek 默认键不同之处在 `desktopNoteId` 里说明，供快捷键页标注；
 * - `legacyCommandId` 指向现有 ZCode 命令表中语义相同的命令，用于迁移期对齐与冲突检查。
 */
import type { ShortcutCommandId } from "@zcode/shared";

export type NekActionId =
  | "tui.input.submit"
  | "tui.input.newLine"
  | "app.message.followUp"
  | "app.interrupt"
  | "app.message.dequeue"
  | "nek.plan.toggle"
  | "app.thinking.cycle"
  | "app.model.select"
  | "app.tools.expand"
  | "app.thinking.toggle"
  | "tui.altScreen.search"
  | "tui.altScreen.previousPrompt"
  | "tui.altScreen.nextPrompt"
  | "tui.altScreen.top"
  | "tui.altScreen.bottom"
  | "app.session.new"
  | "gui.settings.open"
  | "app.editor.external"
  | "gui.commandPalette.open"
  | "gui.interaction.focus";

/** 作用域：composer = 输入框聚焦时生效；global = 窗口级。 */
export type NekActionScope = "composer" | "global";

/**
 * 全局动作的键盘派发阶段（composer 动作固定 bubble，不受此字段影响）。
 *
 * - `capture`（默认）：窗口先手，适合浏览器的默认行为要压制的键（Ctrl+O 打开文件等）；
 * - `bubble`：内层组件先手，适合「Esc 只关最内层」这类必须让对话框 / 提及面板先消费的键。
 */
export type NekActionDispatchPhase = "capture" | "bubble";

/** 快捷键页分组。 */
export type NekActionCategory = "input" | "modeModel" | "displayNavigation" | "other";

export interface NekActionDisabledReason {
  readonly id: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

export interface NekActionDefinition {
  readonly id: NekActionId;
  readonly category: NekActionCategory;
  readonly scope: NekActionScope;
  readonly defaultBindings: readonly string[];
  readonly legacyCommandId?: ShortcutCommandId;
  /** 与 nek 终端默认键不同的说明（i18n key）。 */
  readonly desktopNoteId?: string;
  /** 输入框聚焦时是否允许全局动作抢占输入法/编辑器按键。 */
  readonly allowInEditable?: boolean;
  /** 全局动作的键盘派发阶段（默认 capture）。 */
  readonly dispatchPhase?: NekActionDispatchPhase;
  /** 当前 GUI 尚未提供目标时，设置中心用于解释不可用原因。 */
  readonly disabledReason?: NekActionDisabledReason;
}

/**
 * 动作表。
 *
 * 说明：`tui.input.submit` / `tui.input.newLine` / `app.message.followUp` 三条输入动作由
 * composer 自己的绑定表执行（`shortcuts/composerShortcuts.ts` + Lexical `KeyboardPlugin`），
 * 派发器不重复消费 Enter —— 否则用户把 composerSend 改绑成非 Enter 键后，裸 Enter 会
 * 被动作表抢先当成发送。
 */
export const NEK_ACTIONS: readonly NekActionDefinition[] = [
  {
    id: "tui.input.submit",
    category: "input",
    scope: "composer",
    defaultBindings: ["Enter"],
    legacyCommandId: "composerSend",
  },
  {
    id: "tui.input.newLine",
    category: "input",
    scope: "composer",
    defaultBindings: ["Shift+Enter"],
    legacyCommandId: "composerInsertNewline",
  },
  {
    id: "app.message.followUp",
    category: "input",
    scope: "composer",
    defaultBindings: ["Alt+Enter"],
    desktopNoteId: "shortcuts.action.note.followUp",
  },
  {
    id: "app.interrupt",
    category: "input",
    scope: "global",
    defaultBindings: ["Escape"],
    allowInEditable: true,
    // Esc 只关最内层：对话框、mention/slash 面板先消费，未被消费才停止生成。
    dispatchPhase: "bubble",
  },
  {
    id: "app.message.dequeue",
    category: "input",
    scope: "composer",
    defaultBindings: ["Alt+ArrowUp"],
    desktopNoteId: "shortcuts.action.note.dequeue",
  },
  {
    id: "nek.plan.toggle",
    category: "modeModel",
    scope: "global",
    defaultBindings: ["Alt+m"],
    legacyCommandId: "cycleSessionMode",
    allowInEditable: true,
  },
  {
    id: "app.thinking.cycle",
    category: "modeModel",
    scope: "composer",
    defaultBindings: ["Shift+Tab"],
    legacyCommandId: "cycleThoughtLevel",
  },
  {
    id: "app.model.select",
    category: "modeModel",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+l"],
    legacyCommandId: "openModelMenu",
  },
  {
    id: "app.tools.expand",
    category: "displayNavigation",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+o"],
  },
  {
    id: "app.thinking.toggle",
    category: "displayNavigation",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+t"],
  },
  {
    id: "tui.altScreen.search",
    category: "displayNavigation",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+f"],
    legacyCommandId: "findInTask",
    allowInEditable: true,
  },
  {
    id: "tui.altScreen.previousPrompt",
    category: "displayNavigation",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+ArrowUp"],
  },
  {
    id: "tui.altScreen.nextPrompt",
    category: "displayNavigation",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+ArrowDown"],
  },
  {
    id: "tui.altScreen.top",
    category: "displayNavigation",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+Home"],
  },
  {
    id: "tui.altScreen.bottom",
    category: "displayNavigation",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+End"],
  },
  {
    id: "app.session.new",
    category: "other",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+n"],
    legacyCommandId: "newTask",
    desktopNoteId: "shortcuts.action.note.sessionNew",
  },
  {
    id: "gui.settings.open",
    category: "other",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+,"],
    legacyCommandId: "openSettings",
  },
  {
    id: "app.editor.external",
    category: "other",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+g"],
    desktopNoteId: "shortcuts.action.note.editorExternal",
    disabledReason: { id: "ui.action.unavailable.externalEditor" },
  },
  {
    id: "gui.commandPalette.open",
    category: "other",
    scope: "global",
    defaultBindings: ["CmdOrCtrl+k"],
    legacyCommandId: "openCommandCenter",
  },
  {
    id: "gui.interaction.focus",
    category: "other",
    scope: "global",
    defaultBindings: ["Alt+i"],
    disabledReason: { id: "ui.action.unavailable.interactionFocus" },
  },
];

const ACTIONS_BY_ID: ReadonlyMap<string, NekActionDefinition> = new Map(
  NEK_ACTIONS.map((action) => [action.id, action]),
);

export function isNekActionId(id: string): id is NekActionId {
  return ACTIONS_BY_ID.has(id);
}

export function getNekAction(id: NekActionId): NekActionDefinition {
  const action = ACTIONS_BY_ID.get(id);
  if (!action) {
    throw new Error(`Unknown nek action: ${id}`);
  }
  return action;
}

/** 动作名称的 i18n key（快捷键页、tooltip 共用）。 */
export function nekActionLabelId(id: NekActionId): string {
  return `shortcuts.action.${id}`;
}
