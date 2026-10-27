import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    // 也兼容 tsc -b 产出的 dist/*.js（vitest 4 默认不排除 dist）。
    return /\.(tsx?|js)$/.test(entry.name) && !/\.(test|d)\./.test(entry.name) ? [path] : [];
  });
}

function usedKeys(): string[] {
  const keys = new Set<string>();
  for (const file of sourceFiles(ROOT)) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /"(settings\.nek\.[A-Za-z0-9_.-]+)"/g,
    )) {
      keys.add(match[1]!);
    }
  }
  return [...keys];
}

describe("settings center i18n", () => {
  const keys = usedKeys();

  it("defines every literal settings.nek key in zh-CN and en-US", () => {
    expect(keys.length).toBeGreaterThan(400);
    expect(keys.filter((key) => !(key in zhCN))).toEqual([]);
    expect(keys.filter((key) => !(key in enUS))).toEqual([]);
  });

  it("keeps both locales in sync for settings.nek keys", () => {
    const zh = Object.keys(zhCN).filter((key) => key.startsWith("settings.nek."));
    const en = new Set(Object.keys(enUS).filter((key) => key.startsWith("settings.nek.")));
    expect(zh.filter((key) => !en.has(key))).toEqual([]);
    expect(zh.length).toBe(en.size);
  });

  it("covers every enumerated dynamic key family", () => {
    const families: Record<string, readonly string[]> = {
      "settings.nek.thinking.": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      "settings.nek.mcp.state.": [
        "connected",
        "connecting",
        "failed",
        "needs_auth",
        "disabled",
        "notRunning",
      ],
      "settings.nek.accounts.state.": [
        "loggedOut",
        "loggedIn",
        "expired",
        "refreshFailed",
        "otherCredential",
      ],
      "settings.nek.accounts.hint.": ["expired", "refreshFailed"],
      "settings.nek.copy.status.": ["copied", "skipped", "failed"],
      "settings.nek.provider.api.": [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generative-ai",
      ],
      "settings.nek.hosts.nek.": ["not_installed", "incompatible", "unknown"],
      "settings.nek.project.resource.": [
        "settings",
        "mcp",
        "extensions",
        "skills",
        "prompts",
        "themes",
        "agents",
        "system_prompt",
        "other",
      ],
    };
    for (const [prefix, values] of Object.entries(families)) {
      for (const value of values) {
        expect(zhCN[`${prefix}${value}`], `${prefix}${value}`).toBeDefined();
        expect(enUS[`${prefix}${value}`], `${prefix}${value}`).toBeDefined();
      }
    }
  });
});
