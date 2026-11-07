import type {
  ZCodeTaskMeta,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
  EditorInfo,
  GitRepositorySummary,
  RemoteTarget,
} from "@zcode/shared";

export interface WorkspaceHeaderState {
  selectedProvider: ZCodeProvider;
}

export type WorkspaceHeaderVariant = "task" | "draft";

export interface WorkspaceHeaderReloadSessionOptions {
  resumeTaskId?: string | null;
  provider?: ZCodeProvider | null;
}

export interface WorkspaceHeaderTitleSectionProps {
  variant?: WorkspaceHeaderVariant;
  readOnlyReason?: string;
  workspaceAbsPath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  remoteTarget?: RemoteTarget;
  localWorkspacePath?: string;
  projectName: string;
  activeTaskTitle: string;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  activeTaskId: string | null;
  activeTraceId: string | null;
  activeSessionId: string | null;
  activeTaskProvider: ZCodeProvider | null;
  resolvedActiveTaskMeta?: ZCodeTaskMeta | null;
  gitSummary: GitRepositorySummary;
  gitDirtyFileCount: number;
  sessionLogPath: string | null;
  nativeSessionLogProvider: ZCodeProvider | null;
  nativeSessionLogPath: string | null;
  nativeSessionLogExists: boolean;
  nativeSessionLogLoading: boolean;
  onReloadSession?: (options?: WorkspaceHeaderReloadSessionOptions) => void | Promise<void>;
  reloadSessionDisabled?: boolean;
  reloadSessionPending?: boolean;
  onRefreshGit: () => void;
  workspaceHeaderState: WorkspaceHeaderState;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  isWindowsDesktop?: boolean;
  simplifyForNarrowRemote?: boolean;
  selectedEditor: EditorInfo | null;
  compact?: boolean;
}

export interface WorkspaceHeaderActionSectionProps {
  variant?: WorkspaceHeaderVariant;
  activeTaskId?: string | null;
  readOnlyReason?: string;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  isDesktop?: boolean;
  isTerminalOpen: boolean;
  isSidePaneOpen: boolean;
  onToggleTerminal: () => void;
  onToggleSidePane: () => void;
  toggleSidePaneShortcutLabel?: string;
  /** 右侧 Git 改动树（GitPane）是否已打开。 */
  isGitOpen?: boolean;
  /** 一键打开/收起右侧 Git 改动树。 */
  onToggleGit?: () => void;
  /** 当前 workspace 是 Git repository 且非 office 模式时才挂出 Git 入口。 */
  showGitButton?: boolean;
  onSelectedEditorChange?: (editor: EditorInfo | null) => void;
  simplifyForNarrowRemote?: boolean;
  hideHelpMenu?: boolean;
  showWindowControls?: boolean;
  useWindowsCaptionSpacing?: boolean;
}
