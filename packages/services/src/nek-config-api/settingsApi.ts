/**
 * settings.json 的读写接口。
 *
 * `readSettings` 返回四部分：本作用域写了什么（values）、合并后的生效值（effective）、
 * nek 默认值（defaults）、诊断（diagnostics）。界面靠这三层显示"继承自全局 / 恢复默认"。
 */
import type {
  NekConfigDiagnostic,
  NekConfigRevision,
  NekConfigScope,
  NekConfigTarget,
  NekSettingsPatch,
  NekSettingsReadResult,
  NekSettingsView,
} from "@zcode/shared/nek-protocol";
import {
  isNekWebSearchProviderSupported,
  NEK_WEB_SEARCH_PROVIDER_MIN_VERSION,
} from "@zcode/shared/nek-protocol";
import { nekSettingsFileSchema, parseWithSchema } from "../nek-agent/config/schemas.js";
import { diagnostic, mergeDeep } from "./documents.js";
import { fieldErrorsOf, validationError } from "./errors.js";
import { settingsPath } from "./paths.js";
import type { NekConfigRuntime } from "./runtime.js";
import {
  NEK_SETTINGS_DEFAULTS,
  settingsPatchToRecord,
  toSettingsView,
} from "./settingsDefaults.js";
import { patchSettingsDocument, readSettingsDocument } from "./settingsDocument.js";

export interface NekSettingsGroup {
  readSettings: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ) => Promise<NekSettingsReadResult>;
  patchSettings: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    patch: NekSettingsPatch,
    options: { revision: string; cwd?: string },
  ) => Promise<NekConfigRevision>;
}

/** 删除标记（`null`）不能出现在校验对象里：它不是合法的 settings 值。 */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) continue;
    result[key] = stripNulls(entry);
  }
  return result;
}

export function validateSettingsPatch(record: Record<string, unknown>): void {
  const validated = parseWithSchema(nekSettingsFileSchema, stripNulls(record));
  if (validated.ok) return;
  throw validationError("invalid settings patch", fieldErrorsOf(validated.issues));
}

/**
 * `webSearch` 的合法组合（nek `getWebSearchSettings()` 的镜像）。
 *
 * 这条规则跨字段、也跨作用域（项目层的 key 可以继承全局的 provider），所以判定放在
 * **合并后的结果**上。空串和纯空白同样是非法值（nek 会 `trim()` 后判空并拒启动），
 * 这里只判断、不改写：密钥原样落盘。
 */
type WebSearchProblem =
  | "invalidProvider"
  | "emptyEndpoint"
  | "emptyApiKey"
  | "missingProvider"
  | "invalidNumResults";

interface WebSearchState {
  provider?: unknown;
  endpoint?: unknown;
  apiKey?: unknown;
  numResults?: unknown;
}

/** 每个问题归到哪个字段：`fieldErrors` 给界面定位，读取诊断给出可读的一句。 */
const WEB_SEARCH_PROBLEMS: Record<WebSearchProblem, { field: string; message: string }> = {
  invalidProvider: { field: "webSearch.provider", message: "expected tavily or exa" },
  emptyEndpoint: { field: "webSearch.endpoint", message: "expected a nonempty string" },
  emptyApiKey: { field: "webSearch.apiKey", message: "expected a nonempty string" },
  missingProvider: {
    field: "webSearch.provider",
    message: "webSearch.apiKey or webSearch.endpoint requires an explicit webSearch.provider",
  },
  invalidNumResults: { field: "webSearch.numResults", message: "expected an integer from 1 to 20" },
};

function webSearchState(record: Record<string, unknown>): WebSearchState {
  return toSettingsView(record).webSearch ?? {};
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 合并结果里所有不合法的 webSearch 组合；空集合表示 nek 能启动。 */
function webSearchProblems(state: WebSearchState): Set<WebSearchProblem> {
  const problems = new Set<WebSearchProblem>();
  if (state.provider !== undefined && state.provider !== "tavily" && state.provider !== "exa") {
    problems.add("invalidProvider");
  }
  if (state.endpoint !== undefined && !isNonEmptyText(state.endpoint)) {
    problems.add("emptyEndpoint");
  }
  if (state.apiKey !== undefined && !isNonEmptyText(state.apiKey)) {
    problems.add("emptyApiKey");
  }
  if (
    state.provider === undefined &&
    (state.endpoint !== undefined || state.apiKey !== undefined)
  ) {
    problems.add("missingProvider");
  }
  const numResults = state.numResults;
  if (
    numResults !== undefined &&
    !(
      typeof numResults === "number" &&
      Number.isInteger(numResults) &&
      numResults >= 1 &&
      numResults <= 20
    )
  ) {
    problems.add("invalidNumResults");
  }
  return problems;
}

function webSearchError(problems: Iterable<WebSearchProblem>, message: string): Error {
  const fieldErrors: Record<string, string> = {};
  for (const problem of problems) {
    fieldErrors[WEB_SEARCH_PROBLEMS[problem].field] = WEB_SEARCH_PROBLEMS[problem].message;
  }
  return validationError(message, fieldErrors);
}

/** 凭据本身变了（新增或换成另一个非空值）；清空/删除不算。 */
function credentialsChanged(previous: WebSearchState, next: WebSearchState): boolean {
  for (const key of ["apiKey", "endpoint"] as const) {
    if (next[key] === previous[key]) continue;
    if (isNonEmptyText(next[key])) return true;
  }
  return false;
}

/** 目标 nek 的搜索能力（版本门禁只看这一项，不抬高 GUI 的全局最低版本）。 */
interface WebSearchCapabilities {
  tavily: boolean;
  nekVersion: string | undefined;
}

/** 读一次目标版本，得到搜索能力；未安装/不兼容/未知/不可解析一律按"不支持 Tavily"。 */
export async function resolveWebSearchCapabilities(
  runtime: NekConfigRuntime,
  target: NekConfigTarget,
): Promise<WebSearchCapabilities> {
  const nekVersion = await runtime.targetNekVersion(target);
  return { tavily: isNekWebSearchProviderSupported(nekVersion), nekVersion };
}

function tavilyVersionMessage(capabilities: WebSearchCapabilities): string {
  return `Tavily web search requires nek ${NEK_WEB_SEARCH_PROVIDER_MIN_VERSION} or newer on the target${
    capabilities.nekVersion ? ` (found ${capabilities.nekVersion})` : " (version unknown)"
  }`;
}

/**
 * `test_web_search` 的前置检查。
 *
 * 探测由目标机器上的 nek 自己读配置执行，GUI 只发 query。旧 nek 忽略 provider 并永远走
 * Exa，所以对"显式 Tavily"的配置做探测等于让旧 CLI 把 Tavily key 发给 Exa —— 即使界面
 * 已经挡住入口，直接调 API 也不能绕过。这里只读配置里的 provider 字段，不解析凭据、
 * 不发探测请求；显式 Exa（全版本可用）照常放行。
 */
export function assertWebSearchProbeSupported(
  settings: Record<string, unknown>,
  capabilities: WebSearchCapabilities,
): void {
  if (capabilities.tavily) return;
  if (webSearchState(settings).provider !== "tavily") return;
  throw webSearchError(["invalidProvider"], tavilyVersionMessage(capabilities));
}

/**
 * 只拒绝"这次写入新引入"的非法状态：
 * - 历史配置里已经有问题（例如旧版界面写的 key 没有 provider）时，改主题、改模型这些
 *   无关补丁照常保存，否则用户必须先修好联网搜索才能改任何设置；
 * - 旧问题不是新非法写入的通行证：缺 provider 时新增或更换 key/endpoint 仍然拒绝，
 *   删除 provider 而留下凭据（新出现的歧义）也拒绝；
 * - 逐步修复（先清掉一个键、再改 numResults、最后选 provider）每一步都合法。
 */
function validateWebSearchMerge(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  capabilities: WebSearchCapabilities,
): void {
  const before = webSearchState(previous);
  const after = webSearchState(next);
  const existing = webSearchProblems(before);
  const current = webSearchProblems(after);
  const introduced = [...current].filter((problem) => !existing.has(problem));
  if (introduced.length > 0) {
    throw webSearchError(introduced, "invalid web search settings");
  }

  if (current.has("missingProvider") && credentialsChanged(before, after)) {
    throw webSearchError(["missingProvider"], "invalid web search settings");
  }

  // 旧 nek 忽略 provider 且永远走 Exa：把 Tavily 的选择或凭据写过去会被静默忽略，
  // 密钥甚至会被发到 Exa。只拦"新引入的 Tavily 配置"，删除与无关字段照常。
  if (!capabilities.tavily) {
    const introducesTavily = after.provider === "tavily" && before.provider !== "tavily";
    const editsTavilyCredentials = after.provider === "tavily" && credentialsChanged(before, after);
    if (introducesTavily || editsTavilyCredentials) {
      throw webSearchError(["invalidProvider"], tavilyVersionMessage(capabilities));
    }
  }
}

export function createSettingsGroup(runtime: NekConfigRuntime): NekSettingsGroup {
  const defaultsRecord = NEK_SETTINGS_DEFAULTS as unknown as Record<string, unknown>;

  return {
    readSettings: async (target, scope, cwd) => {
      const context = runtime.target(target);
      if (scope === "project" && !cwd) {
        throw validationError("project scope requires cwd", { cwd: "required" });
      }
      const path = settingsPath(context.layout, scope, cwd);
      const document = await readSettingsDocument(context.executor, path);
      const diagnostics: NekConfigDiagnostic[] = [];
      const readScope = async (otherScope: NekConfigScope): Promise<Record<string, unknown>> => {
        if (otherScope === "project" && !cwd) return {};
        const otherPath = settingsPath(context.layout, otherScope, cwd);
        if (otherScope === scope) return document.raw;
        try {
          return (await readSettingsDocument(context.executor, otherPath)).raw;
        } catch (error) {
          diagnostics.push(
            diagnostic(otherPath, error instanceof Error ? error.message : String(error)),
          );
          return {};
        }
      };
      const global = await readScope("global");
      const project = await readScope("project");
      const explicit = mergeDeep(global, project);
      // 现存的不合法组合（含旧版界面留下的空值）在读取时给出可见诊断：
      // nek 会因此拒绝启动，但界面不能替用户改文件。
      for (const problem of webSearchProblems(webSearchState(explicit))) {
        const { field, message } = WEB_SEARCH_PROBLEMS[problem];
        diagnostics.push(diagnostic(path, `${field}: ${message}`));
      }
      const effective = mergeDeep(defaultsRecord, explicit);
      const values: NekSettingsView = document.values;
      return {
        path,
        revision: document.revision,
        scope,
        values,
        effective: toSettingsView(effective),
        defaults: NEK_SETTINGS_DEFAULTS,
        diagnostics,
      };
    },

    patchSettings: async (target, scope, patch, options) => {
      const context = runtime.target(target);
      if (scope === "project" && !options.cwd) {
        throw validationError("project scope requires cwd", { cwd: "required" });
      }
      const record = settingsPatchToRecord(patch as Record<string, unknown>);
      validateSettingsPatch(record);
      const inherited =
        scope === "project"
          ? (await readSettingsDocument(context.executor, settingsPath(context.layout, "global")))
              .raw
          : {};
      // 只有会碰到搜索配置的写入才需要目标版本：目标表要经过 host（远程是 SSH），
      // 普通设置的补丁不该为了一次能力判断多跑一趟。
      let capabilities: WebSearchCapabilities = { tavily: true, nekVersion: undefined };
      if ("webSearch" in record) {
        capabilities = await resolveWebSearchCapabilities(runtime, target);
      }
      const patched = await patchSettingsDocument({
        executor: context.executor,
        path: settingsPath(context.layout, scope, options.cwd),
        patch: record,
        expectedRevision: options.revision,
        validate: (merged, previous) =>
          validateWebSearchMerge(
            mergeDeep(inherited, previous),
            mergeDeep(inherited, merged),
            capabilities,
          ),
      });
      runtime.publishWrite(target, [patched]);
      return { revision: patched.revision };
    },
  };
}
