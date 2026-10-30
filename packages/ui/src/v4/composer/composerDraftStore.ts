// composer parity：v4 composer 的 per-session 草稿持久化（新做，轻量 localStorage）。
//
// 旧草稿面（zcodeSessionStore composerDraftByScopeId + chatComposerDraftStorage 写路径）
// 已随 store 收尾删除；本模块是 v4 侧替代——键空间独立（v4 前缀），不与旧键互写，
// 旧键清理仍归 chatComposerDraftStorage 的 janitor。
// 语义：scope = sessionId（draft 态 = "__draft__"）；保存 text + editorStateJson，外部预填在
// Lexical 尚未挂载时额外保存 mention（保证重挂载不降级为纯文本）。
// mode/modelSelection 与正文同 scope 保存；发送只清内容，显式清理才删除整个 scope。
// 只持久化已完成上传的 AttachmentRef（objectUrl/File 内容本体不落盘），恢复时由 composer
// 把引用交回现有 session-owned attachment 通道；未完成上传项仍只留在 renderer 内存。
import { logger } from "@/logger.js";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared";
import {
  attachmentRefSchema,
  submissionModeSchema,
  type AttachmentRef,
  type SubmissionMode,
} from "@zcode/shared/zcode-protocol-v4";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

export interface V4ComposerDraft {
  text: string;
  editorStateJson?: string;
  mention?: ComposerMentionPrefill;
  /** 有合法 mode 表示已经初始化；没有模型仍是明确空态，不能按旧文本草稿补默认。 */
  mode?: SubmissionMode;
  planEnabled?: boolean;
  /** 已处理的工具变更，防止重连快照再次覆盖用户选择。 */
  lastPlanTransitionId?: string;
  lastPermissionGrantId?: string;
  modelSelection?: ModelSelection;
  /** 已完成上传的引用；内容本体仍由 host/runtime 持有。 */
  attachments?: readonly AttachmentRef[];
  /** 首次分享导入等待公共新任务初始化；不能由空 Session snapshot 抢先填充。 */
  initializeFromNewTask?: true;
  updatedAt: number;
}

interface V4DraftFile {
  version: 1;
  scopes: Record<string, V4ComposerDraft>;
}

const STORAGE_KEY_PREFIX = "zcode-v4-composer-drafts:v1:";
export const V4_DRAFT_SCOPE_ROOT = "__draft__";
/** 最多保存 50 个会话草稿，避免长期工作区占满 renderer localStorage。 */
export const MAX_V4_DRAFT_SCOPES = 50;
/** 单条正文最多 128 KiB；编辑器 JSON 超出剩余预算时不落盘 JSON。 */
export const MAX_V4_DRAFT_TEXT_BYTES = 128 * 1024;
export const MAX_V4_DRAFT_ATTACHMENTS = 8;
const warnedStorageKeys = new Set<string>();

function warnStorageFailure(key: string, error: unknown) {
  if (warnedStorageKeys.has(key)) return;
  warnedStorageKeys.add(key);
  logger.warn("[v4-composer-draft] 草稿持久化访问失败", {
    error: error instanceof Error ? error.message : String(error),
    key,
  });
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getV4ComposerDraftStorageKey(workspacePath: string, workspaceIdentity?: string): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceKey)}`;
}

function readDraftFile(key: string): V4DraftFile {
  const storage = getStorage();
  try {
    const raw = storage?.getItem(key);
    if (!raw) return { version: 1, scopes: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.scopes)) {
      return { version: 1, scopes: {} };
    }
    const scopes = Object.fromEntries(
      Object.entries(parsed.scopes)
        .flatMap(([scopeId, value]) => {
          const draft = readDraft(value);
          return draft ? [[scopeId, draft] as const] : [];
        })
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_V4_DRAFT_SCOPES),
    );
    return { version: 1, scopes };
  } catch (error) {
    warnStorageFailure(key, error);
    return { version: 1, scopes: {} };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (new TextEncoder().encode(value).byteLength <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (new TextEncoder().encode(value.slice(0, middle)).byteLength <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}

function readDraft(value: unknown): V4ComposerDraft | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  const mode = submissionModeSchema.safeParse(value.mode);
  const selection = modelSelectionSchema.safeParse(value.modelSelection);
  // 坏 options 不应连带丢掉可确定的模型身份；不读取旧 provider/model/thought 别名。
  const identity = isRecord(value.modelSelection)
    ? modelSelectionSchema.safeParse({
        providerId: value.modelSelection.providerId,
        modelId: value.modelSelection.modelId,
      })
    : null;
  const modelSelection = selection.success
    ? selection.data
    : identity?.success
      ? identity.data
      : undefined;
  const mention = value.mention;
  const hasMention =
    isRecord(mention) &&
    ["id", "category", "label", "value", "markdown"].every(
      (key) => typeof mention[key] === "string",
    ) &&
    ["files", "skills", "commands", "subagents", "sessions", "plugins"].includes(
      String(mention.category),
    );
  const text = truncateUtf8(value.text, MAX_V4_DRAFT_TEXT_BYTES);
  const editorStateJson =
    typeof value.editorStateJson === "string" &&
    new TextEncoder().encode(value.editorStateJson).byteLength <= MAX_V4_DRAFT_TEXT_BYTES
      ? value.editorStateJson
      : undefined;
  const parsedAttachments = attachmentRefSchema.array().safeParse(value.attachments);
  const attachments = parsedAttachments.success
    ? parsedAttachments.data.slice(0, MAX_V4_DRAFT_ATTACHMENTS)
    : undefined;
  return {
    text,
    ...(editorStateJson ? { editorStateJson } : {}),
    ...(hasMention ? { mention: mention as unknown as ComposerMentionPrefill } : {}),
    ...(mode.success ? { mode: mode.data === "plan" ? ("agent" as const) : mode.data } : {}),
    ...(typeof value.planEnabled === "boolean"
      ? { planEnabled: value.planEnabled }
      : mode.success
        ? { planEnabled: mode.data === "plan" }
        : {}),
    ...(typeof value.lastPermissionGrantId === "string"
      ? { lastPermissionGrantId: value.lastPermissionGrantId }
      : {}),
    ...(typeof value.lastPlanTransitionId === "string"
      ? { lastPlanTransitionId: value.lastPlanTransitionId }
      : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(value.initializeFromNewTask === true && !mode.success
      ? { initializeFromNewTask: true as const }
      : {}),
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

function normalizeDraftForStorage(
  draft: Omit<V4ComposerDraft, "updatedAt">,
): Omit<V4ComposerDraft, "updatedAt"> {
  const text = truncateUtf8(draft.text, MAX_V4_DRAFT_TEXT_BYTES);
  const editorStateJson =
    draft.editorStateJson &&
    new TextEncoder().encode(draft.editorStateJson).byteLength <= MAX_V4_DRAFT_TEXT_BYTES
      ? draft.editorStateJson
      : undefined;
  const attachments = draft.attachments?.slice(0, MAX_V4_DRAFT_ATTACHMENTS);
  return {
    ...draft,
    text,
    ...(editorStateJson ? { editorStateJson } : { editorStateJson: undefined }),
    ...(attachments && attachments.length > 0 ? { attachments } : { attachments: undefined }),
  };
}

function writeDraftFile(key: string, file: V4DraftFile) {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    if (Object.keys(file.scopes).length === 0) {
      storage.removeItem(key);
      return true;
    }
    const boundedScopes = Object.fromEntries(
      Object.entries(file.scopes)
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_V4_DRAFT_SCOPES),
    );
    storage.setItem(key, JSON.stringify({ version: 1, scopes: boundedScopes }));
    warnedStorageKeys.delete(key);
    return true;
  } catch (error) {
    // 配额/隐私模式失败只降级为不持久化，不影响输入。
    warnStorageFailure(key, error);
    return false;
  }
}

export function readV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
): V4ComposerDraft | null {
  const key = getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const draft = readDraftFile(key).scopes[scopeId];
  if (!draft || typeof draft.text !== "string") {
    return null;
  }
  return draft;
}

export function persistV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
  draft: Omit<V4ComposerDraft, "updatedAt">,
) {
  const key = getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const file = readDraftFile(key);
  if (
    !draft.text.trim() &&
    !draft.editorStateJson &&
    !draft.mention &&
    !draft.mode &&
    !draft.modelSelection &&
    !draft.attachments?.length &&
    !draft.initializeFromNewTask
  ) {
    delete file.scopes[scopeId];
  } else {
    const normalized = normalizeDraftForStorage(draft);
    const latestUpdatedAt = Object.values(file.scopes).reduce(
      (latest, current) => Math.max(latest, current.updatedAt),
      0,
    );
    file.scopes[scopeId] = {
      ...normalized,
      updatedAt: Math.max(Date.now(), latestUpdatedAt + 1),
    };
  }
  return writeDraftFile(key, file);
}

export function clearV4ComposerDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
) {
  const key = getV4ComposerDraftStorageKey(workspacePath, workspaceIdentity);
  const file = readDraftFile(key);
  if (!(scopeId in file.scopes)) {
    return true;
  }
  delete file.scopes[scopeId];
  return writeDraftFile(key, file);
}
