import type { IServiceAccessor } from "@zcode/services";

export function buildRemoteWorkspaceSessionServices(
  baseServices: IServiceAccessor,
  remoteServices: IServiceAccessor,
): IServiceAccessor {
  return {
    ...baseServices,
    fileService: remoteServices.fileService,
    mediaPreviewService: remoteServices.mediaPreviewService,
    gitService: remoteServices.gitService,
    gitCheckpointService: remoteServices.gitCheckpointService,
    systemService: remoteServices.systemService,
    terminalService: remoteServices.terminalService,
    // 远端附件必须由当前 workspace host 上传并改写路径；沿用本地服务会把
    // 桌面机的绝对路径原样传给 SSH/WSL/Docker 中的 CLI，导致附件无法读取。
    promptAttachmentTransferService: remoteServices.promptAttachmentTransferService,
    zcodeAgentService: remoteServices.zcodeAgentService,
    zcodeTaskService: remoteServices.zcodeTaskService,
    zcodeSessionService: remoteServices.zcodeSessionService,
    // 分享使用本地登录/API，但 Rows 与文件必须绑定当前远端 connection scope。
    conversationShareService: remoteServices.conversationShareService,
    fileWatcherService: remoteServices.fileWatcherService,
    // Provider/Model 事实属于目标 Environment；不能因 merge 先展开 baseServices 而回落到本地。
    modelSelectionService: remoteServices.modelSelectionService,
    nekWorkspaceConfigService: remoteServices.nekWorkspaceConfigService,
  };
}
