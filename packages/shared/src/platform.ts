import type { RendererHeapSample } from "./validation.js";
/* eslint-disable max-lines -- 跨端 platform contract 集中声明 renderer 能力；原生操作必须保持 desktop/web 类型合同，本 MR 不拆分平台边界。 */
import type {
  DockerConnectOptions,
  RemoteTarget,
  SSHConnectOptions,
  WSLConnectOptions,
} from "./remoteTarget.js";
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./mcp.js";
import type { AppSettings, Locale } from "./protocol.js";
import type {
  PostUpdateReleaseNotesPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
} from "./update.js";
export type {
  PostUpdateReleaseNotesPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
} from "./update.js";

/**
 * 当前生效的 ZCode Built-in Provider Config 物化副本信息。
 * path 为 null 表示所在环境尚未物化（未启动过 server）或路径不可用。
 */
export interface BuiltinProviderConfigFileInfo {
  readonly path: string | null;
  readonly exists: boolean;
}

export interface TaskNotificationPayload {
  taskId: string;
  status: "completed" | "failed" | "elicitation_request";
  requestId?: string;
  title: string;
  body: string;
}

export const LOCAL_MEDIA_PREVIEW_SCHEME = "zcode-media";

export function buildLocalMediaPreviewUrl(path: string): string {
  const url = new URL(`${LOCAL_MEDIA_PREVIEW_SCHEME}://local/preview`);
  url.searchParams.set("path", path);
  return url.toString();
}

/** 已安装的编辑器/终端信息 */
export interface EditorInfo {
  /** 编辑器标识 (e.g. "vscode", "zed", "terminal") */
  id: string;
  /** 显示名 */
  name: string;
  /** 图标 base64 data URL */
  iconDataUrl: string;
}

export interface ApplicationIconInfo {
  iconDataUrl: string;
}

export type ApplicationIconLocator =
  | { kind: "darwin-bundle-id"; value: string }
  | { kind: "windows-executable-path"; value: string }
  | { kind: "windows-aumid"; value: string };

export interface ApplicationIconRequest {
  locators: ApplicationIconLocator[];
}

export type OpenInEditorRemoteTarget =
  | Pick<SSHConnectOptions, "kind" | "host" | "port" | "username" | "sshConfigAlias">
  | Pick<WSLConnectOptions, "kind" | "distro" | "user">
  | Pick<DockerConnectOptions, "kind" | "container">;

export interface OpenInEditorOptions {
  remoteTarget?: OpenInEditorRemoteTarget;
  workspaceIdentity?: string;
  pathKind?: "file" | "directory";
}

export interface CreateTempTextAttachmentRequest {
  text: string;
  filename?: string;
}

export interface CreateTempTextAttachmentResult {
  filename: string;
  localPath: string;
  mimeType: "text/plain";
  sizeBytes: number;
}

export type SaveFileRequest =
  | {
      data: ArrayBuffer;
      sourceUrl?: never;
      suggestedName: string;
    }
  | {
      data?: never;
      sourceUrl: string;
      suggestedName: string;
    };

export interface SelectedFileData {
  name: string;
  data: ArrayBuffer;
}

export interface SaveFileResult {
  /** 实际保存的文件名，不含目录。 */
  name?: string;
  /** 浏览器只确认已发起下载，无法确认用户是否最终保存到磁盘。 */
  downloadStarted?: boolean;
  canceled?: boolean;
  error?: string;
  path?: string;
  success: boolean;
}

export interface PrintPageToPdfResult {
  success: boolean;
  /** PDF 字节；success 时存在 */
  data?: ArrayBuffer;
  /** "print_in_progress" | "print_failed" */
  error?: string;
}

export function createOpenInEditorRemoteTarget(target: RemoteTarget): OpenInEditorRemoteTarget {
  switch (target.kind) {
    case "ssh":
      // openInEditor 只需要构造 VS Code Remote-SSH URI 的连接标识，
      // 不应该把 password/privateKeyPassphrase 等凭据字段继续穿过 renderer/preload/main IPC。
      return {
        kind: "ssh",
        host: target.host,
        port: target.port,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
      };
    case "wsl": {
      const user = target.user?.trim();
      return {
        kind: "wsl",
        distro: target.distro,
        ...(user ? { user } : {}),
      };
    }
    case "docker":
      return {
        kind: "docker",
        container: target.container,
      };
  }
}

export interface WSLDistro {
  name: string;
  isDefault: boolean;
  state: string;
  version: 1 | 2 | null;
}

export interface DockerContainerInfo {
  id: string;
  image: string;
  name: string;
  state: string;
  status: string;
}

export interface SSHConfigAliasOption {
  alias: string;
  host?: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  source?: string;
}

export interface ZCodeStdioTapDevState {
  enabled: boolean;
  visible: boolean;
  logDir: string;
  statePath: string;
}

export type DesktopTitleBarTheme = "light" | "dark" | "system";

export interface WindowScreenshotResult {
  dataBase64: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface WindowControlsOverlayMetrics {
  leftPaddingPx?: number;
  rightPaddingPx?: number;
  titleBarHeightPx?: number;
}

export interface WindowControlsOverlayReadyPayload {
  zoomLevel: number;
  metrics: WindowControlsOverlayMetrics;
}

export interface DesktopZoomState {
  zoomLevel: number;
}

export interface DesktopWindowChromeState {
  isMaximized: boolean;
  /** 本机 macOS 主版本；非 macOS 或无法解析时为 null。 */
  macOSMajorVersion?: number | null;
  supportsNativeRoundedCorners: boolean;
}

export interface RemoteServiceSession {
  sessionId: string;
}

export interface RemoteConnectionRuntimeLog {
  label: string;
  requestId?: string;
  sessionId?: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  timestamp: string;
}

export interface RemoteSessionClosedEvent {
  sessionId: string;
  reason: "host-exit";
  exitCode: number | null;
  signal: string | null;
}

export interface ConnectRemoteRequest {
  target: RemoteTarget;
  requestId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  connectTrigger?: import("./remoteTarget.js").RemoteWorkspaceConnectTrigger;
}

export interface CancelPendingRemoteConnectionRequest {
  requestId?: string;
}

export interface BindRemoteWorkspaceSessionContextRequest {
  remoteSessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export const DesktopCommandIds = {
  NewTask: "newTask",
  OpenWorkspace: "openWorkspace",
  CloseActiveContext: "closeActiveContext",
  CloseWindow: "closeWindow",
  MinimizeWindow: "minimizeWindow",
  ToggleMaximizeWindow: "toggleMaximizeWindow",
  ToggleFullScreen: "toggleFullScreen",
  ResetWindowSize: "resetWindowSize",
  ResetZoom: "resetZoom",
  ZoomIn: "zoomIn",
  ZoomOut: "zoomOut",
  ShowAbout: "showAbout",
  OpenChangelog: "openChangelog",
  CheckForUpdates: "checkForUpdates",
  RelaunchApp: "relaunchApp",
  OpenCommunity: "openCommunity",
  ExportLogs: "exportLogs",
  ToggleDevTools: "toggleDevTools",
  OpenResourceManager: "openResourceManager",
  ToggleZCodeStdioTapDevProxy: "toggleZCodeStdioTapDevProxy",
  SetZCodeEndpointProduction: "setZCodeEndpointProduction",
  SetZCodeEndpointTest: "setZCodeEndpointTest",
  SetZCodeEndpointCustom: "setZCodeEndpointCustom",
  ResetZCodeEndpoint: "resetZCodeEndpoint",
  ClearAllData: "clearAllData",
} as const;

export type DesktopCommandId = (typeof DesktopCommandIds)[keyof typeof DesktopCommandIds];

/**
 * 平台操作接口 —— 替代直接访问 window.zcode
 *
 * 定义需要宿主环境（Electron main / Web server）参与的操作。
 * Desktop 和 Web 各自提供不同的实现，UI 层通过此接口统一消费。
 *
 * 设计原则：只放"必须穿越进程边界且不适合做成 RPC service"的操作，
 * 比如 native dialog、窗口生命周期控制等。
 * 业务服务（文件、终端、凭据等）走 IServiceAccessor 的 RPC 通道。
 */
export interface IPlatformService {
  /** 当前平台的文件选择框是否能返回 agent 可访问的本地绝对路径 */
  canSelectFilePath?: boolean;

  /** 打开系统目录选择框，返回选中路径或 null */
  selectDirectory(): Promise<string | null>;

  /** 打开系统文件选择框，返回选中文件路径或 null */
  selectFile(): Promise<string | null>;

  /** 用户显式选文件；读取前验证大小，取消返回 null。 */
  selectFileData?(options: { accept: string; maxBytes: number }): Promise<SelectedFileData | null>;

  /** 打开系统多文件选择框，返回选中的文件路径；取消时返回空数组 */
  selectFiles?(): Promise<string[]>;

  /** 桌面另存为，或 Web 浏览器下载；取消不是成功。 */
  saveFile?(payload: SaveFileRequest): Promise<SaveFileResult>;

  /**
   * 用 Chromium 打印引擎把当前 webContents 的 print 媒体版面输出为 PDF（矢量文本）。
   * 页面尺寸由 renderer 注入的 @page CSS 决定（preferCSSPageSize）；仅 Desktop 实现。
   */
  printPageToPdf?(): Promise<PrintPageToPdfResult>;

  /**
   * 从浏览器 File 对象解析宿主本地路径；只有 Desktop preload 能安全实现。
   * Web/手机端返回 null，避免 UI 层依赖 Electron 的非标准 File.path。
   */
  getPathForFile?(file: unknown): string | null;

  /** 把 Agent 已授权的 Desktop 本地视频路径转换为可供媒体元素读取的宿主 URL。 */
  createLocalMediaPreviewUrl?(path: string): string;

  /**
   * 在宿主 ~/.zcodium 临时目录创建文本附件文件。
   * 手机远控必须通过 shared-host/platform proxy 写到桌面宿主，避免大文本进入 prompt payload。
   */
  createTempTextAttachment?(
    payload: CreateTempTextAttachmentRequest,
  ): Promise<CreateTempTextAttachmentResult>;

  /** 订阅当前窗口内远程连接过程日志，返回 disposer */
  onRemoteConnectionLog(handler: (entry: RemoteConnectionRuntimeLog) => void): () => void;

  /** 订阅远程 workspace session 关闭事件，返回 disposer */
  onRemoteSessionClosed(handler: (event: RemoteSessionClosedEvent) => void): () => void;

  /** 检查目录是否已在其他窗口打开；如果是则激活该窗口并切到对应 tab */
  activateOrSetWorkspace(path: string): Promise<{ activated: boolean }>;

  /** 建立远程连接（Desktop: 在当前窗口创建远程 session；Web: HTTP API） */
  connectRemote(
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath: string;
      workspaceIdentity?: string;
      connectTrigger?: import("./remoteTarget.js").RemoteWorkspaceConnectTrigger;
    },
  ): Promise<{ success: boolean; error?: string; sessionId?: string }>;

  /** 取消当前窗口尚未建立完成的远程连接（可选：Web 平台可忽略） */
  cancelPendingRemoteConnection?(requestId?: string): Promise<void>;

  /** 将 canonical workspace 身份绑定到已创建的远程 logical session。 */
  bindRemoteWorkspaceSessionContext?(
    context: BindRemoteWorkspaceSessionContextRequest,
  ): Promise<void>;

  /** 释放当前窗口里已创建的远程 session */
  disposeRemoteSession(sessionId: string): Promise<void>;

  /** 检查本机 Docker daemon 是否可用 */
  isDockerAvailable(): Promise<boolean>;

  /** 列出本机可用的 WSL 发行版 */
  listWSLDistros(): Promise<WSLDistro[]>;

  /** 列出当前可连接的 Docker 容器 */
  listDockerContainers(): Promise<DockerContainerInfo[]>;

  /** 列出当前机器 SSH config 中可用于快速填表的 alias */
  listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;

  /** 读取宿主环境中的原生 MCP 用户目录配置；手机远控通过已连接桌面 host 转发。 */
  loadMcpFromUserDirectory?(
    payload?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;

  /** 写入宿主环境中的原生 MCP 用户目录配置；普通 Web 没有宿主时返回 unsupported。 */
  saveMcpToUserDirectory?(
    payload: SaveCliMcpToUserDirectoryRequest,
  ): Promise<{ success: boolean; error?: string }>;

  /** 迁移旧版 Common MCP 配置；仅宿主环境可执行，手机远控通过 desktop attachment 转发。 */
  migrateLegacyCommonMcp?(
    payload?: MigrateLegacyCommonMcpRequest,
  ): Promise<MigrateLegacyCommonMcpResult>;

  /** 打开外部 URL（用于 OAuth 跳转浏览器） */
  openExternal(url: string): void;

  /** 按系统应用标识读取真实 App 图标；非 Desktop 平台可不实现。 */
  getApplicationIcon?(
    request: string | ApplicationIconRequest,
  ): Promise<ApplicationIconInfo | null>;

  /** 打开用户社群入口，由平台自行解析当前语言对应渠道 */
  openCommunity(): Promise<void>;

  /** 查询当前语言下是否存在可用的用户社群入口 */
  canOpenCommunity(locale: Locale): Promise<boolean>;

  /** 在系统文件管理器中打开指定路径 */
  openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;

  /** 使用系统默认应用打开本地文件；普通 Web 平台返回 unsupported。 */
  openExternalFile?(path: string): Promise<{ success: boolean; error?: string }>;

  /** 查询当前生效的 ZCode Built-in Provider Config 物化副本；Web 平台不支持。 */
  getBuiltinProviderConfigFile?(): Promise<BuiltinProviderConfigFileInfo>;

  /** 通知 main process renderer 已就绪，触发缓存的冷启动 deep link 转发 */
  notifyRendererReady(): void;

  /** 触发任务状态对应的系统通知，由宿主环境决定是否真正展示 */
  showTaskNotification(payload: TaskNotificationPayload): void;
  reportRendererHeapSample?(sample: RendererHeapSample): void;
  reportDiagnostic?(record: import("./diagnostics.js").DiagnosticRecordInput): void;
  reportLocalTtftBatch?(batch: import("./localTtft.js").LocalTtftBatch): void;

  /** 同步当前窗口所有 tab 的 workspace 路径到 main 进程（用于跨窗口去重） */
  syncWindowTabs(paths: string[]): void;

  /** 同步当前窗口的未读 task 数给宿主环境，用于 Dock / 任务栏徽标聚合 */
  syncWindowUnreadCount(count: number): void;
  /** 当前窗口 active task 变化；Main 只在该窗口前台时发布全局 PiP focus。 */
  syncActiveTaskSession(sessionId: string | null): void;

  /** 同步需要 main 进程即时感知的应用设置；Web fallback 可忽略 */
  syncAppSettings?(patch: Partial<AppSettings>): void;

  /** 注册 main 进程要求聚焦某个 workspace tab 的回调，返回 disposer */
  onFocusTab(handler: (path: string) => void): () => void;

  /** 注册 main 进程触发新建 tab 的回调，返回 disposer */
  onNewTab(handler: () => void): () => void;

  /** 注册 main 进程请求关闭当前上下文的回调，返回 disposer */
  onCloseActiveContextRequest?(handler: () => void): () => void;

  /** 注册 main 进程触发新建任务的回调，返回 disposer */
  onNewTask(handler: () => void): () => void;

  /** 注册 main 进程触发打开工作区的回调，返回 disposer */
  onOpenWorkspace(handler: () => void): () => void;

  /** 注册 main 进程通过 deep link 直接打开本地工作区目录的回调，返回 disposer */
  onOpenWorkspacePath?(handler: (path: string) => void): () => void;

  /** 注册窗口全屏状态变化回调，返回 disposer */
  onWindowFullscreenChanged(handler: (isFullscreen: boolean) => void): () => void;

  /** 读取当前桌面窗口最大化状态与系统原生圆角能力 */
  getDesktopWindowChromeState?(): Promise<DesktopWindowChromeState>;

  /** 注册桌面窗口最大化状态与系统原生圆角能力变化回调 */
  onDesktopWindowChromeStateChanged?(
    handler: (state: DesktopWindowChromeState) => void,
  ): () => void;

  /** 同步读取当前原生窗口控制区安全边距，用于首屏启动态初始化 */
  getWindowControlsOverlayMetrics?(): WindowControlsOverlayMetrics | null;

  /** 注册原生窗口控制区安全边距变化回调，返回 disposer */
  onWindowControlsOverlayChanged?(
    handler: (metrics: WindowControlsOverlayMetrics) => void,
  ): () => void;

  /** 同步读取当前桌面窗口页面缩放档位；Web fallback 可返回默认 0 */
  getDesktopZoomLevel?(): Promise<DesktopZoomState>;

  /** 注册当前桌面窗口页面缩放档位变化回调，返回 disposer */
  onDesktopZoomLevelChanged?(handler: (state: DesktopZoomState) => void): () => void;

  /** 注册用户点击系统通知后跳转到对应任务的回调，返回 disposer */
  onTaskNotificationClick(handler: (taskId: string) => void): () => void;

  /** 导出日志：打包 ~/.zcodium/v2 及外部 agent 日志为 zip 并在系统文件浏览器中显示 */
  exportLogs(): Promise<{ success: boolean; path?: string; error?: string }>;

  /** 截取当前窗口，用于错误反馈携带现场画面；Web fallback 可返回 null */
  captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>;

  /** 注册新版本已下载完毕的回调，参数为新版本号，返回 disposer */
  onUpdateReady(callback: (version: string) => void): () => void;

  /** 注册"手动检查更新"结果的回调（用于 toast 反馈），返回 disposer */
  onUpdateCheckResult(callback: (payload: UpdateCheckResultPayload) => void): () => void;

  /** 注册自动更新持续状态变化的回调，返回 disposer */
  onUpdateStateChanged?(callback: (payload: UpdateStatePayload) => void): () => void;

  /** 主动读取当前自动更新状态，用于菜单打开时补偿异步事件丢失 */
  getUpdateState?(): Promise<UpdateStatePayload>;

  /** 用户在更新弹窗中确认开始下载当前已发现版本 */
  downloadUpdate(): Promise<void>;

  /** 用户在更新弹窗中取消当前下载中的更新 */
  cancelUpdateDownload(): Promise<void>;

  /** 打开桌面端独立更新窗口；非桌面端可不实现并回退到内嵌弹窗 */
  openUpdateStatusWindow?(): Promise<void>;

  /** 读取桌面端自动更新偏好；非桌面端可返回默认值 */
  getAutoUpdatePreferences?(): Promise<{
    autoDownloadAndInstallUpdates: boolean;
  }>;

  /** 写入“以后自动下载并安装更新”偏好；非桌面端可 no-op */
  setAutoDownloadAndInstallUpdates?(enabled: boolean): Promise<void>;

  /** 用户跳过当前已发现版本；main 进程负责按当前通道持久化 */
  skipUpdateVersion(version: string): Promise<void>;

  /** 查询桌面端当前正在运行的会话数量；非桌面端可返回 0 */
  getDesktopSessionActivity?(): Promise<{
    runningAgentSessionCount: number;
  }>;

  /** 开发环境 stdio tap proxy 开关状态；非桌面平台可不实现 */
  getZCodeStdioTapDevState?(): Promise<ZCodeStdioTapDevState>;

  /** 是否为本地开发运行形态；桌面端用 !app.isPackaged 注入，Web 端可省略。 */
  isLocalDevelopmentRuntime?: boolean;

  /** 设置文件由桌面菜单命令更新后的通知，renderer 用于刷新 settings snapshot。 */
  onSettingsChanged?(callback: () => void): () => void;

  /** 桌面主进程解析后的应用语言变化；独立轻量窗口没有 settingService 时使用。 */
  onApplicationLocaleChanged?(callback: (locale: Locale) => void): () => void;

  /** 宿主系统语言；桌面端由 main 进程读取，Web 端可回退到 navigator.language。 */
  getSystemLocale?(): Promise<Locale>;

  /** 注册更新完成后的版本说明，返回 disposer */
  onPostUpdateReleaseNotes(callback: (payload: PostUpdateReleaseNotesPayload) => void): () => void;

  /** 标记当前版本说明已读，允许 main 进程清理持久化状态 */
  acknowledgePostUpdateReleaseNotes(version: string): Promise<void>;

  /** 用户确认重启安装更新 */
  quitAndInstallUpdate(): Promise<void>;

  /** 获取系统中已安装的编辑器/终端列表（含图标） */
  getInstalledEditors(): Promise<EditorInfo[]>;

  /** 用指定编辑器打开路径 */
  openInEditor(
    editorId: string,
    path: string,
    options?: OpenInEditorOptions,
  ): Promise<{ success: boolean; error?: string }>;

  /** 执行桌面窗口级命令（标题栏菜单、缩放、窗口控制等）。
   *  返回值直通 main 进程 handler 的 return，因此放宽为 unknown。 */
  executeDesktopCommand(command: DesktopCommandId): Promise<unknown>;

  /** 同步应用菜单语言，驱动 main 进程重建原生菜单 */
  setApplicationLocale(locale: Locale): Promise<void>;

  /** 同步桌面标题栏亮/暗色，驱动原生窗口控制按钮配色 */
  setTitleBarTheme(theme: DesktopTitleBarTheme): Promise<void>;
}
