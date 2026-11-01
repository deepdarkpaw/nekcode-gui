import {
  buildLocalMediaPreviewUrl,
  formatLogPrefix,
  type ServiceAuthorityMode,
} from "@zcode/shared";
import { ServiceCollection } from "./collection.js";
import { IFileService } from "./file/file.js";
import { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import { IGitService } from "./git/git.js";
import { IGitCheckpointService } from "./git/gitCheckpoint.js";
import { ISystemService } from "./system/system.js";
import { ITerminalService } from "./terminal/terminal.js";
import { ISettingService } from "./setting/setting.js";
import { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import { ICredentialService } from "./credential/credential.js";
import { IBroadcastService } from "./broadcast/broadcast.js";
import { IZCodeTaskService } from "./session/zcodeTaskService.js";
import { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import {
  createUnsupportedConversationShareService,
  IConversationShareService,
  type IConversationShareService as IConversationShareServiceType,
} from "./conversation-share/conversationShare.js";
import { ConversationShareService } from "./conversation-share/conversationShareService.js";
import { createLocalConversationShareArtifactSource } from "./conversation-share/conversationShareArtifactSource.js";
import { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import { IClientScenesService } from "./client-scenes/clientScenes.js";
import { ISkillsService } from "./skills/skills.js";
import { ISkillSyncService } from "./skill-sync/skillSync.js";
import { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import { ISubagentsService } from "./subagents/subagents.js";
import { ICommandsService } from "./commands/commands.js";
import { IHooksService } from "./hooks/hooks.js";
import { IMemoryService } from "./memory/memory.js";
import { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createFileService } from "./file/fileService.js";
import { createMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { WorkspaceFileSearchFilter } from "./file/workspaceFileMentionFilter.js";
import { createGitService } from "./git/gitService.js";
import { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
import { createGitCheckpointService } from "./git/gitCheckpointService.js";
import { createSystemService } from "./system/systemService.js";
import { createTerminalService } from "./terminal/terminalService.js";
import { createSettingService } from "./setting/settingService.js";
import { createOnboardingRecordService } from "./onboarding/onboardingRecordService.js";
import { createObservableSettingService } from "./setting/observableSettingService.js";
import { createCredentialService } from "./credential/credentialService.js";
import { createBroadcastService } from "./broadcast/broadcastService.js";
import { createNekZCodeAgentService } from "./nek-agent/adapter/index.js";
import type { ZCodeAgentCommandResolver } from "./zcode-agent/zcodeAgentCommand.js";
import { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
import { createZCodeTaskIndexSyncer } from "./zcode-agent/zcodeTaskIndexSyncer.js";
import { TaskIndexRepo } from "./session/taskIndexRepo.js";
import type { SessionMessageSendRequested } from "./session/sessionMailbox.js";
import { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
import { IModelSelectionService } from "./model-provider/modelSelectionService.js";
import { createNekModelFactsSource } from "./model-provider/nekModelFacts.js";
import { createNekModelSelectionService } from "./model-provider/nekModelSelectionService.js";
import { NekConfigApi, createLocalNekConfigTargetHost } from "./nek-config-api/index.js";
import { createClientScenesService } from "./client-scenes/clientScenesService.js";
import { createSkillsService } from "./skills/skillsService.js";
import { createSkillSyncService } from "./skill-sync/skillSyncService.js";
import { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
import { createSubagentsService } from "./subagents/subagentsService.js";
import { createCommandsService } from "./commands/commandsService.js";
import { createHooksService } from "./hooks/hooksService.js";
import { createMemoryService } from "./memory/memoryService.js";
import { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
import { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
import {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
import type {
  RuntimeProcessLifecycleReporter,
  RuntimeTaskReporter,
} from "./process/runtimeProcessLifecycle.js";
import { initializeRuntimeProcessEnv } from "./runtime-tools/runtimeCommandEnv.js";
import { ensureAppCaCert } from "./runtime-tools/appCaCert.js";
import { createServiceLogger } from "./logger/serviceLogger.js";
import {
  registerHostApiNetworkTransportForDispose,
  registerLocalServiceResources,
} from "./localServiceResources.js";

interface CreateLocalServicesOptions {
  parentPort?: Parameters<typeof createBroadcastService>[0];
  settingService?: ISettingService;
  credentialService?: ICredentialService;
  hostApiNetworkTransport?: HostApiNetworkTransport;
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  taskRuntimeReporter?: RuntimeTaskReporter;
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
  forwardSessionMessageSendRequested?: (
    request: SessionMessageSendRequested,
  ) => Promise<void> | void;
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
  runtimeProcessEnvPatch?: Record<string, string>;
  zcodeAgentSpawnFallbackCwd?: string;
  remoteAgentNetwork?: { httpProxy?: string; noProxy?: string };
  serviceAuthorityMode?: ServiceAuthorityMode;
  agentRuntimeContext?: { runtimeSurface?: "desktop_local_host" | "remote_workspace_host" };
}

/** Creates local services on the target machine; nek owns all model/configuration facts. */
export function createLocalServices(options: CreateLocalServicesOptions): ServiceCollection {
  const isDesktopAttachedRemote = options.serviceAuthorityMode === "desktop-attached-remote";
  initializeRuntimeProcessEnv(options.runtimeProcessEnvPatch);
  try {
    ensureAppCaCert();
  } catch (error) {
    console.error(formatLogPrefix("appCaCert", process.pid), "ensure app CA cert failed:", error);
  }
  const settingService = createObservableSettingService(
    options.settingService ?? createSettingService(),
  );
  const hostApiNetworkTransport =
    options.hostApiNetworkTransport ??
    createHostApiNetworkTransport(async () => {
      const settings = await settingService.get();
      return {
        httpProxy: settings.httpProxy,
        noProxy: settings.httpProxyNoProxy,
        caCertPath: settings.httpProxyCaCertPath,
      };
    });
  const taskIndexRepo = new TaskIndexRepo();
  const nekModelLog = createServiceLogger("nek-model-selection");
  const nekConfigApi = new NekConfigApi({
    hosts: createLocalNekConfigTargetHost(),
    logger: { warn: (...args) => nekModelLog.warn(undefined, ...args) },
  });
  const modelSelectionService = createNekModelSelectionService({
    facts: createNekModelFactsSource(nekConfigApi, { log: nekModelLog }),
  });
  const zcodeAgentService = createNekZCodeAgentService({ cwd: options.zcodeAgentSpawnFallbackCwd });
  const zcodeTaskIndexSyncer = createZCodeTaskIndexSyncer({
    agentService: zcodeAgentService,
    taskIndexRepo,
  });
  const zcodeSessionService = createZCodeSessionService({
    agentService: zcodeAgentService,
    taskIndexSyncer: zcodeTaskIndexSyncer,
  });
  const gitCommitMessageGenerator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel(params) {
        return (
          (
            await modelSelectionService.getView({
              selection: null,
              workspacePath: params.workspacePath,
            })
          ).preferredSelection ?? null
        );
      },
    },
    textGenerator: {
      async generateText(params) {
        return await zcodeAgentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          selection: params.selection,
          prompt: params.prompt,
          querySource: params.querySource,
        });
      },
    },
    logger: createServiceLogger("git-commit-message"),
  });
  const fileService = createFileService({
    workspaceFileSearchFilter: options.workspaceFileSearchFilter,
  });
  const conversationShareService: IConversationShareServiceType = isDesktopAttachedRemote
    ? createUnsupportedConversationShareService({
        message: "Conversation publishing is not available for remote workspaces",
      })
    : new ConversationShareService({
        zcodeAgentService,
        zcodeSessionService,
        artifactSource: createLocalConversationShareArtifactSource(),
      });
  const services = new ServiceCollection()
    .register(IFileService, fileService)
    .register(
      IMediaPreviewService,
      createMediaPreviewService({
        fileService,
        authorizeLocalMediaPreviewPath: options.authorizeLocalMediaPreviewPath,
        createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
      }),
    )
    .register(IGitService, createGitService({ commitMessageGenerator: gitCommitMessageGenerator }))
    .register(IGitCheckpointService, createGitCheckpointService())
    .register(ISystemService, createSystemService())
    .register(ITerminalService, createTerminalService({ settingService }))
    .register(ISettingService, settingService)
    .register(IOnboardingRecordService, createOnboardingRecordService())
    .register(ICredentialService, options.credentialService ?? createCredentialService())
    .register(IBroadcastService, createBroadcastService(options.parentPort ?? null))
    .register(
      IZCodeTaskService,
      createZCodeTaskServiceAdapter({
        zcodeAgentService,
        taskIndexRepo,
        taskIndexSyncer: zcodeTaskIndexSyncer,
        settingService,
      }),
    )
    .register(IZCodeAgentService, zcodeAgentService)
    .register(IZCodeSessionService, zcodeSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(IFileWatcherService, createFileWatcherService())
    .register(IModelSelectionService, modelSelectionService)
    .register(IClientScenesService, createClientScenesService())
    .register(ISkillsService, createSkillsService({ isDesktopRuntime: true }))
    .register(ISkillSyncService, createSkillSyncService())
    .register(
      IMcpSyncService,
      createMcpSyncService({
        listMcpServerStatuses: (params) => zcodeAgentService.listMcpServerStatuses(params),
      }),
    )
    .register(ISubagentsService, createSubagentsService({ isDesktopRuntime: true }))
    .register(ICommandsService, createCommandsService({ isDesktopRuntime: true }))
    .register(
      IHooksService,
      createHooksService({
        grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
      }),
    )
    .register(IMemoryService, createMemoryService())
    .register(ISettingsSyncService, createSettingsSyncService({ settingService }))
    .register(IPromptAttachmentTransferService, createLocalPromptAttachmentTransferService());
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  registerLocalServiceResources(services, {
    dispose: () => {
      taskIndexRepo.close();
      modelSelectionService.dispose();
      nekConfigApi.dispose();
    },
  });
  return services;
}
