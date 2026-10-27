/**
 * API Key 输入：字面量（默认掩码）、环境变量（写成 `$NAME`）、命令（`!cmd`，只读展示，原样保留）。
 */
import type { NekProviderView } from "@zcode/shared/nek-protocol";

export type ApiKeyMode = "literal" | "env" | "command";

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 编辑态：`value` 为空且 `keepExisting` 时保存为 `{ keep: true }`。 */
export interface ApiKeyDraft {
  mode: ApiKeyMode;
  value: string;
  /** 原值存在且用户没有改动字面量时为 true。 */
  keepExisting: boolean;
  /** 用户显式点了"清除密钥"：写入 `{ remove: true }`，不是空串。 */
  remove: boolean;
}

export type ApiKeyDraftError = "envName" | null;

/** 粘贴的密钥去掉所有空白（复制时常带换行或空格）。 */
export function sanitizePastedApiKey(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 从读取视图得到初始编辑态。 */
export function apiKeyDraftFromView(view: NekProviderView["apiKey"] | undefined): ApiKeyDraft {
  switch (view?.kind) {
    case "literal":
      return { mode: "literal", value: "", keepExisting: true, remove: false };
    case "env":
      return { mode: "env", value: view.name, keepExisting: false, remove: false };
    case "command":
      return { mode: "command", value: view.command, keepExisting: false, remove: false };
    default:
      return { mode: "literal", value: "", keepExisting: false, remove: false };
  }
}

/** 解析用户在环境变量输入框里写的 `$NAME` / `${NAME}` / `NAME`。 */
export function normalizeEnvName(value: string): string {
  const trimmed = value.trim();
  const braced = /^\$\{(.+)\}$/.exec(trimmed);
  if (braced) {
    return braced[1] ?? "";
  }
  return trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
}

export function validateApiKeyDraft(draft: ApiKeyDraft): ApiKeyDraftError {
  if (draft.mode !== "env") {
    return null;
  }
  const name = normalizeEnvName(draft.value);
  return name === "" || ENV_NAME_PATTERN.test(name) ? null : "envName";
}

/**
 * 写入值：`{ keep: true }` 保持原值，`{ remove: true }` 删除密钥。
 *
 * 契约不接受空串（那既不是"删除"也不是"保持"），所以这里永远不发 `""`：
 * 清空输入框等同于删除，显式的"清除密钥"按钮同样发 `{ remove: true }`。
 */
export function apiKeyWriteFromDraft(
  draft: ApiKeyDraft,
): string | { keep: true } | { remove: true } {
  if (draft.remove) {
    return { remove: true };
  }
  if (draft.mode === "env") {
    const name = normalizeEnvName(draft.value);
    return name === "" ? { remove: true } : `$${name}`;
  }
  if (draft.mode === "command") {
    const command = draft.value.trim();
    if (command === "") {
      return { remove: true };
    }
    return command.startsWith("!") ? command : `!${command}`;
  }
  if (draft.value === "" && draft.keepExisting) {
    return { keep: true };
  }
  return draft.value === "" ? { remove: true } : draft.value;
}

/** 草稿形式（`$NAME`、字面量）用于测试连接 / 拉取模型；保持原值时返回 undefined，由后端使用已存的值。 */
export function apiKeyForDraftRequest(draft: ApiKeyDraft): string | undefined {
  const write = apiKeyWriteFromDraft(draft);
  return typeof write === "string" ? write : undefined;
}
