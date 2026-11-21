import type { NekConfigRevision, NekConfigScope, NekConfigTarget } from "./config-types.js";
import type {
  NekListResourcesResult,
  NekResourceType,
  NekSetResourceEnabledResult,
} from "./gui-rpc.js";

export interface NekResourceQuery {
  resourceType: NekResourceType;
  cwd?: string;
}

export interface NekResourceFileRef extends NekResourceQuery {
  /** 只接受 nek 列出的文件路径，不接受目录。 */
  path: string;
}

export interface NekResourceCatalog extends NekListResourcesResult {
  roots: { global: string; project?: string };
}

/** 远端执行器的命令参数也必须能装下 base64 编码后的文档。 */
export const MAX_NEK_RESOURCE_FILE_BYTES = 48 * 1024;

export interface INekResourceConfigApi {
  listConfigResources(
    target: NekConfigTarget,
    query: NekResourceQuery,
  ): Promise<NekResourceCatalog>;
  setResourceEnabled(
    target: NekConfigTarget,
    input: NekResourceFileRef & { enabled: boolean },
  ): Promise<NekSetResourceEnabledResult>;
  createResource(
    target: NekConfigTarget,
    input: NekResourceQuery & {
      scope: NekConfigScope;
      name: string;
      description?: string;
      content: string;
    },
  ): Promise<void>;
  readPromptTemplate(
    target: NekConfigTarget,
    input: NekResourceFileRef,
  ): Promise<NekConfigRevision & { content: string }>;
  writePromptTemplate(
    target: NekConfigTarget,
    input: NekResourceFileRef & NekConfigRevision & { content: string },
  ): Promise<void>;
  deleteResource(target: NekConfigTarget, input: NekResourceFileRef): Promise<void>;
}
