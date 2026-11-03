/**
 * 被动观察者（`runtimePolicy: "existing-only"`）读到“没有现成 runtime”时的稳定错误。
 *
 * 这是预期结果而不是故障：观察者据此休眠或按摘要处理，不能为了读数据拉起 Agent。
 */
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "./zcodeAgent.js";

export class ZCodeAgentRuntimeUnavailableError extends Error {
  readonly code = ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;

  constructor(message: string) {
    super(message);
    this.name = "ZCodeAgentRuntimeUnavailableError";
  }
}

export function isZCodeAgentRuntimeUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
  );
}
