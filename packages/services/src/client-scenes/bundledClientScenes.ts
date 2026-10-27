import type { ClientSceneConfig, ClientSceneItem } from "./clientScenes.js";

type LocalizedText = { cn: string; en: string };

function item(
  id: string,
  img: string,
  labels: LocalizedText,
  contents: LocalizedText,
): ClientSceneItem {
  return { id, type: "prompt", img, labels, contents };
}

const scheduledPrompts = [
  {
    ...item(
      "morning-git-summary",
      "git-branch",
      { cn: "工作日项目摘要", en: "Weekday project summary" },
      {
        cn: "读取当前项目最近一个工作日的本地 Git 提交与工作区状态，总结主要变化、未完成事项和需要我确认的问题。只生成报告，不修改文件或向外部发送报告。",
        en: "Review this project's local Git commits from the last working day and its working tree status. Summarize changes, unfinished work, and questions for me. Produce a report without modifying files or sending it elsewhere.",
      },
    ),
    defaults: { cronExpr: ["weekday-morning"] },
  },
  {
    ...item(
      "documentation-review",
      "book-open",
      { cn: "每周文档检查", en: "Weekly documentation review" },
      {
        cn: "对照当前项目源码检查 README 中的命令、入口和功能描述，列出过期或缺失的说明及对应源码依据。只生成待修订清单，不自动修改文档。",
        en: "Compare the README's commands, entry points, and feature descriptions with the current source. List outdated or missing documentation with source evidence. Produce a revision checklist without changing documents.",
      },
    ),
    defaults: { cronExpr: ["weekly-review"] },
  },
  {
    ...item(
      "release-summary",
      "file-check",
      { cn: "每周变更摘要", en: "Weekly change summary" },
      {
        cn: "根据当前项目最近七天的本地 Git 提交，起草面向用户的变更摘要，区分新功能、修复和兼容性变化。标明未验证的部分，不创建标签、不推送、不发布。",
        en: "Draft a user-facing summary from this project's local Git commits over the last seven days. Separate features, fixes, and compatibility changes. Identify unverified details. Do not create tags, push, or publish.",
      },
    ),
    defaults: { cronExpr: ["weekly-review"] },
  },
];

/** Read-only product content; no account, endpoint, image URL, or device context. */
const bundledScenes: ClientSceneConfig[] = [
  {
    namespace: "zcodium",
    scene: "scheduled-task",
    options: {
      prompts: {
        id: "prompts",
        type: "prompts",
        contents: { cn: "定时任务", en: "Scheduled tasks" },
        items: scheduledPrompts,
      },
      cronExpr: {
        id: "cronExpr",
        type: "cronExpr",
        contents: { cn: "执行时间", en: "Schedule" },
        items: [
          {
            id: "weekday-morning",
            type: "cronExpr",
            labels: { cn: "工作日 09:00", en: "Weekdays at 09:00" },
            contents: { cn: "0 9 * * 1-5", en: "0 9 * * 1-5" },
          },
          {
            id: "weekly-review",
            type: "cronExpr",
            labels: { cn: "周五 16:00", en: "Fridays at 16:00" },
            contents: { cn: "0 16 * * 5", en: "0 16 * * 5" },
          },
        ],
      },
    },
  },
];

export function readBundledClientScenes(): ClientSceneConfig[] {
  return structuredClone(bundledScenes);
}
