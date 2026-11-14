import { useEffect, useState, useSyncExternalStore } from "react";
import type { IZCodeAgentService } from "@zcode/services";
import {
  createSubagentHistoryConversation,
  type SubagentHistoryConversation,
} from "./subagentHistoryConversation.js";
import {
  subagentHistoryScopeKey,
  type SubagentHistoryScope,
  type SubagentHistoryState,
} from "./subagentHistoryTypes.js";

const EMPTY: SubagentHistoryState = { error: null, retry: async () => undefined };
const readEmpty = () => EMPTY;
const subscribeEmpty = () => () => undefined;

/** React owns one lease per trusted child tab; creation performs IO only after commit. */
export function useSubagentHistoryConversation({
  service,
  scope,
  active,
  query = "",
}: {
  service: IZCodeAgentService;
  scope: SubagentHistoryScope;
  active: boolean;
  query?: string;
}): SubagentHistoryState {
  const scopeKey = subagentHistoryScopeKey(scope);
  const [owner, setOwner] = useState<{
    service: IZCodeAgentService;
    scopeKey: string;
    controller: SubagentHistoryConversation;
  }>();
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    rootSessionId,
    parentSessionId,
    childSessionId,
  } = scope;
  useEffect(() => {
    const controller = createSubagentHistoryConversation(
      service,
      {
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        rootSessionId,
        parentSessionId,
        childSessionId,
      },
      { active: false },
    );
    setOwner({ service, scopeKey, controller });
    return () => controller.close();
  }, [
    service,
    scopeKey,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    rootSessionId,
    parentSessionId,
    childSessionId,
  ]);
  const controller =
    owner?.service === service && owner.scopeKey === scopeKey ? owner.controller : undefined;
  useEffect(() => {
    controller?.setQuery(query);
    controller?.setActive(active);
  }, [controller, query, active]);
  return useSyncExternalStore(
    controller?.subscribe ?? subscribeEmpty,
    controller?.getState ?? readEmpty,
    readEmpty,
  );
}
