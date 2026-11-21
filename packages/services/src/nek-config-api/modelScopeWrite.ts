import type {
  NekConfigRevision,
  NekConfigTarget,
  NekModelScopeEntry,
} from "@zcode/shared/nek-protocol";
import { readModelScope } from "./controlApi.js";
import { readCheckedDocument, writeTextDocument } from "./documents.js";
import { asNekConfigError, conflict, ioError } from "./errors.js";
import { modelScopeReferenceEdit, type ModelScopeRename } from "./modelScopeReferences.js";
import {
  effectiveScopeDocument,
  modelScopePatterns,
  readModelScopeDocuments,
  sameModelScopePatterns,
} from "./modelScopeSettings.js";
import { prepareModelsEdit, type NekJsoncEdit, type NekModelsSnapshot } from "./modelsDocument.js";
import { sameRevision } from "./revision.js";
import type { NekConfigRuntime } from "./runtime.js";
import { patchSettingsDocument, type NekSettingsDocument } from "./settingsDocument.js";

interface ModelWriteOptions {
  revision: string;
  cwd?: string;
  rename?: ModelScopeRename;
  globalSettings?: {
    document?: NekSettingsDocument;
    patch: (document: NekSettingsDocument) => Record<string, unknown>;
  };
}

type WrittenFile = NekConfigRevision & { path: string };

/** 与 CLI 一样，看写入前的解析结果；新模型自然命中旧模式不等于要追加该模式。 */
async function scopeBeforeAddition(
  runtime: NekConfigRuntime,
  target: NekConfigTarget,
  document: NekSettingsDocument,
  cwd?: string,
): Promise<NekModelScopeEntry[]> {
  const patterns = modelScopePatterns(document);
  if (!patterns.length) return [];
  const scope = await readModelScope(runtime, target, cwd);
  if (!sameModelScopePatterns(scope.patterns, patterns)) throw conflict(document.path);
  return scope.models;
}

/**
 * 模型新增/移除与范围同步的唯一落盘路径。先验证候选，再加锁合并 settings，最后原子写模型。
 * 两份文件没有共同事务；先写范围使锁失败不会把模型落盘，重试也不会撞上已经新增的 ID。
 */
export async function writeModelsAndScope(
  runtime: NekConfigRuntime,
  target: NekConfigTarget,
  snapshot: NekModelsSnapshot,
  edits: readonly NekJsoncEdit[],
  options: ModelWriteOptions,
): Promise<{ revision: string; written: WrittenFile[] }> {
  if (!sameRevision(snapshot.revision, options.revision)) throw conflict(snapshot.path);
  const candidate = prepareModelsEdit(snapshot, edits);
  const transform = modelScopeReferenceEdit(
    snapshot.providers,
    candidate.providers,
    options.rename,
  );
  const context = runtime.target(target);
  const written: WrittenFile[] = [];
  try {
    if (transform || options.globalSettings) {
      const documents = await readModelScopeDocuments(
        runtime,
        context,
        transform ? options.cwd : undefined,
        options.globalSettings?.document,
      );
      const effective = effectiveScopeDocument(documents);
      const scoped = transform?.hasAdditions
        ? await scopeBeforeAddition(runtime, target, effective, options.cwd)
        : [];
      for (const document of [documents.global, documents.project]) {
        if (!document) continue;
        const patch =
          document === documents.global ? (options.globalSettings?.patch(document) ?? {}) : {};
        if (transform) {
          const current = modelScopePatterns(document);
          const next = transform.apply(current, document === effective ? scoped : []);
          if (!sameModelScopePatterns(current, next)) patch.enabledModels = next;
        }
        if (!Object.keys(patch).length) continue;
        written.push(
          await patchSettingsDocument({
            executor: context.executor,
            path: document.path,
            expectedRevision: document.revision,
            patch,
          }),
        );
      }
    }
    // nek 只读 models.json；沿用原有写前 revision 校验，不覆盖 CLI/GUI 的并发文件修改。
    await readCheckedDocument(context.executor, snapshot.path, options.revision);
    const revision = await writeTextDocument(context.executor, snapshot.path, candidate.text);
    written.push({ path: snapshot.path, revision });
    return { revision, written };
  } catch (error) {
    if (!written.length) throw error;
    runtime.publishWrite(target, written);
    throw ioError(
      `Model settings were saved in ${written.map(({ path }) => path).join(", ")}, but the model save did not complete: ${asNekConfigError(error).message}. Reload the configuration and retry.`,
    );
  }
}
