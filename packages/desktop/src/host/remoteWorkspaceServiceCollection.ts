import {
  ServiceCollection,
  IFileService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  IConversationShareService,
  IFileWatcherService,
  IModelSelectionService,
  INekWorkspaceConfigService,
  IClientScenesService,
  IPromptAttachmentTransferService,
  type IServiceAccessor,
} from "@zcode/services";
import {
  ConversationShareService,
  createSettingService,
  createCredentialService,
  createBroadcastService,
  createHostApiNetworkTransport,
  registerHostApiNetworkTransportForDispose,
  createClientScenesService,
  createRemoteConversationShareArtifactSource,
} from "@zcode/services/node";
import { assertLegacyRemoteWorkspaceRpcContract } from "./legacyRemoteWorkspaceRpcContract.js";

export function createRemoteWorkspaceServiceCollection(params: {
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
  parentPort: Parameters<typeof createBroadcastService>[0];
  createReportingRemoteZCodeTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentSessionService: <T extends object>(service: T) => T;
  promptAttachmentTransferService: IPromptAttachmentTransferService;
}): ServiceCollection {
  const remote = params.connectionServices;
  assertLegacyRemoteWorkspaceRpcContract(remote);
  const localSettingService = createSettingService();
  const localCredentialService = createCredentialService();
  const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
    const settings = await localSettingService.get();
    return {
      httpProxy: settings.httpProxy,
      noProxy: settings.httpProxyNoProxy,
      caCertPath: settings.httpProxyCaCertPath,
    };
  });
  const conversationShareService = new ConversationShareService({
    zcodeAgentService: remote.zcodeAgentService,
    artifactSource: createRemoteConversationShareArtifactSource(remote.fileService),
  });
  // 附件物化包在 reporting 外层，让消息镜像与远端 agent 收到同一份远端路径。
  const remoteZCodeTaskService = params.createRemotePromptAttachmentTaskService(
    params.createReportingRemoteZCodeTaskService(remote.zcodeTaskService),
  );
  const remoteZCodeSessionService = params.createRemotePromptAttachmentSessionService(
    remote.zcodeSessionService,
  );

  // GUI 偏好与凭据留在本机，nek 配置和会话事实只来自当前连接。
  const services = new ServiceCollection()
    .register(IFileService, remote.fileService)
    .register(IGitService, remote.gitService)
    .register(IGitCheckpointService, remote.gitCheckpointService)
    .register(ISystemService, remote.systemService)
    .register(ITerminalService, remote.terminalService)
    .register(ISettingService, localSettingService)
    .register(ICredentialService, localCredentialService)
    .register(IBroadcastService, createBroadcastService(params.parentPort))
    .register(IZCodeTaskService, remoteZCodeTaskService)
    .register(IZCodeAgentService, remote.zcodeAgentService)
    .register(IZCodeSessionService, remoteZCodeSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(IFileWatcherService, remote.fileWatcherService)
    .register(IModelSelectionService, remote.modelSelectionService)
    .register(INekWorkspaceConfigService, remote.nekWorkspaceConfigService)
    .register(IClientScenesService, createClientScenesService())
    .register(IPromptAttachmentTransferService, params.promptAttachmentTransferService);
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  return services;
}
