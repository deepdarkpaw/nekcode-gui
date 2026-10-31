import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isNekActionId } from "@/shortcuts/nekActions.js";
import enUS from "./locales/en-US.js";
import zhCN from "./locales/zh-CN.js";

/**
 * 守卫：UI 源码里引用的 nekcode 新增文案 id（`nek.*`、`onboarding.*`、`remote.nek.*`、`ui.*`）
 * 必须在两种语言里都有定义。交互卡曾整批漏掉 37 个 key，界面直接显示原始 id；
 * 单元测试只断言 id，发现不了。
 * 快捷键动作 id（同样以 `nek.` 开头，如 `nek.plan.toggle`）不是文案，排除在外。
 */
const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MESSAGE_ID =
  /["'`]((?:nek|onboarding|remote\.nek|ui)\.[a-zA-Z][A-Za-z0-9]*(?:\.[a-zA-Z][A-Za-z0-9]*)+)["'`]/g;

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "locales" ? [] : collectSourceFiles(path);
    return /\.tsx?$/u.test(entry.name) && !/\.test\./u.test(entry.name) ? [path] : [];
  });
}

function referencedMessageIds(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const file of collectSourceFiles(SRC_ROOT)) {
    for (const match of readFileSync(file, "utf8").matchAll(MESSAGE_ID)) {
      const id = match[1];
      if (id && !isNekActionId(id)) ids.set(id, file.slice(SRC_ROOT.length));
    }
  }
  return ids;
}

describe("nekcode message ids", () => {
  it("defines every referenced nekcode message id in zh-CN and en-US", () => {
    const ids = referencedMessageIds();
    expect(ids.size).toBeGreaterThan(50);
    const missing = [...ids].flatMap(([id, file]) => {
      const locales = [id in zhCN ? null : "zh-CN", id in enUS ? null : "en-US"].filter(
        (locale) => locale !== null,
      );
      return locales.length > 0 ? [`${id} (${locales.join(", ")}) ← ${file}`] : [];
    });
    expect(missing).toEqual([]);
  });
});
