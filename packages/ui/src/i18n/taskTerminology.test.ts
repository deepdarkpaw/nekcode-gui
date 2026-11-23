import { expect, it } from "vitest";
import enUS from "./locales/en-US.js";
import zhCN from "./locales/zh-CN.js";

const LOCALES = { "zh-CN": zhCN, "en-US": enUS };

const TASK_LABELS = {
  "taskList.newTask": ["新建任务", "New task"],
  "taskList.rename": ["重命名任务", "Rename task"],
  "v4Pane.deleteSession": ["删除任务", "Delete task"],
  "quickPick.section.chat": ["任务", "Tasks"],
  "commandCenter.scope.conversations": ["任务", "Tasks"],
  "appHeader.copySessionId": ["复制任务 ID", "Copy task ID"],
  "chat.mention.sessions.title": ["任务", "Tasks"],
  "chat.slash.session.title": ["任务信息", "Task information"],
  "chat.slash.session.file": ["任务文件", "Task file"],
  "chat.turnNavigator.label": ["任务问题导航", "Task query map"],
  "shortcuts.action.app.session.new": ["新建任务", "New task"],
  "notification.completed": ["任务已完成", "Task completed"],
};

/** These sessions are connection/terminal lifetimes, not the app's work object. */
const NON_TASK_SESSIONS = new Set([
  // SSH / WSL / Docker connection setup, before the user chooses a workspace.
  "remote.settingsStepDescription",
  "remote.connectedConfirmTitle",
  "remote.connectedConfirmDescription",
  "remote.leaveConnectedSession",
  "remote.log.requestingSession",
  "remote.log.sessionReady",
  "wsl.rootWarning",
  // The shell setting applies on terminal creation, not on task creation.
  "settings.integratedTerminalShellDescription",
]);

const OLD_TASK_TERMS =
  /会话|对话(?!框)|聊天|子智能体|\b(?:sessions?|conversations?|chats?|sub[- ]agents?)\b|\bplan\s*(?:mode|模式)|\b(?:agent\s*\/\s*plan|plan\s*\/\s*agent)\b/iu;

function visibleProse(message: string): string {
  // A literal command/flag and the OpenAI protocol name must remain recognizable.
  return message
    .replace(/(^|[\s`(（])(?:\/session|--session)(?![\w/-])/gu, "$1")
    .replace(/\bchat completions\b/giu, "");
}

it("TT-1 task entry points, navigation, shortcuts, and information use the same object name", () => {
  for (const [key, expected] of Object.entries(TASK_LABELS)) {
    expect([zhCN[key], enUS[key]], key).toEqual(expected);
  }
});

it("TT-2 uses Subagent and Planning mode, without renaming plans themselves", () => {
  expect([zhCN["sidePane.subagent"], enUS["sidePane.subagent"]]).toEqual(["子代理", "Subagent"]);
  expect([zhCN["mode.label.plan"], enUS["mode.label.plan"]]).toEqual(["计划模式", "Planning mode"]);
  expect([zhCN["planTool.panel.planTab"], enUS["planTool.panel.planTab"]]).toEqual([
    "计划",
    "Plan",
  ]);
});

it("TT-3 ships the same message keys in both languages", () => {
  expect(Object.keys(zhCN).sort()).toEqual(Object.keys(enUS).sort());
});

it("TT-4 guards product copy but exempts connection sessions, protocols, and archive-owned copy", () => {
  const violations: string[] = [];
  for (const [locale, messages] of Object.entries(LOCALES)) {
    for (const [key, value] of Object.entries(messages)) {
      if (NON_TASK_SESSIONS.has(key) || key.startsWith("conversationShare.")) continue;
      const prose = visibleProse(value);
      if (OLD_TASK_TERMS.test(prose) || /\bSubAgents?\b/u.test(prose)) {
        violations.push(`${locale} ${key}: ${value}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
