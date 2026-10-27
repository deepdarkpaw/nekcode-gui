/* eslint-disable max-lines -- commandsService 需要集中处理目录来源优先级、读写和命令解析，拆分会削弱读取顺序的一致性 */
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  ZCODE_COMMAND_AGENT_SOURCE,
  ZCODE_COMMAND_AGENT_SOURCES,
  ZCODE_USER_DATA_DIR_NAME,
  ZCODE_WORKSPACE_CONFIG_DIR_NAME,
  type CommandAgentSource,
  type CommandConfig,
  type CommandCreateParams,
  type CommandDeleteParams,
  type CommandSetEnabledParams,
  type CommandUpdateParams,
  type CommandsListResult,
  type SettingsDirectoryLocation,
  type SettingsDirectorySource,
  type UserCommand,
} from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { ICommandsService } from "./commands.js";
import { CommandFileParser, type CommandFileFormat } from "./commandFileParser.js";

function resolveUserHomeDir() {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

interface CommandAgentSourceDescriptor {
  agentSource: CommandAgentSource;
  directorySource: SettingsDirectorySource;
  userDirectorySegments: readonly string[];
  workspaceDirectorySegments: readonly string[];
  fileExtension: ".md" | ".toml";
  format: CommandFileFormat;
  namespaceSeparator: "/" | ":";
  supportsArgumentHint: boolean;
}

const DEFAULT_COMMAND_AGENT_SOURCE: CommandAgentSource = ZCODE_COMMAND_AGENT_SOURCE;
const COMMAND_AGENT_SOURCE_ORDER: readonly CommandAgentSource[] = ZCODE_COMMAND_AGENT_SOURCES;
const ENABLE_OVERRIDE_KEY = "enable";
const ZCODE_COMMAND_DESCRIPTOR: CommandAgentSourceDescriptor = {
  agentSource: "zcodeAgent",
  directorySource: "zcode",
  userDirectorySegments: [ZCODE_USER_DATA_DIR_NAME, "commands"],
  workspaceDirectorySegments: [ZCODE_WORKSPACE_CONFIG_DIR_NAME, "commands"],
  fileExtension: ".md",
  format: "markdown",
  namespaceSeparator: "/",
  supportsArgumentHint: true,
};

const COMMAND_AGENT_SOURCE_DESCRIPTORS: Record<CommandAgentSource, CommandAgentSourceDescriptor> = {
  zcodeAgent: ZCODE_COMMAND_DESCRIPTOR,
};

const COMMAND_DIRECTORY_SOURCE_DESCRIPTORS: readonly CommandAgentSourceDescriptor[] = [
  ZCODE_COMMAND_DESCRIPTOR,
  {
    ...ZCODE_COMMAND_DESCRIPTOR,
    directorySource: "agents",
    userDirectorySegments: [".agents", "commands"],
    workspaceDirectorySegments: [".agents", "commands"],
  },
];

function getCommandSourceDescriptor(
  agentSource: CommandAgentSource = DEFAULT_COMMAND_AGENT_SOURCE,
): CommandAgentSourceDescriptor {
  return COMMAND_AGENT_SOURCE_DESCRIPTORS[agentSource];
}

function getUserCommandsRoot(agentSource?: CommandAgentSource): string {
  const descriptor = getCommandSourceDescriptor(agentSource);
  return join(resolveUserHomeDir(), ...descriptor.userDirectorySegments);
}

function getUserCliConfigPath(): string {
  return join(resolveUserHomeDir(), ZCODE_USER_DATA_DIR_NAME, "cli", "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readUserCliConfig(): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(getUserCliConfigPath(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeUserCliConfig(config: Record<string, unknown>): Promise<void> {
  const filePath = getUserCliConfigPath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/**
 * 在跨进程锁内完成 config.json 的读-改-写。
 *
 * Bug 原因：config.json 由 Main、Host 与 CLI 共同写入，原先各调用点锁外读、锁外写，
 * 后写的一方用旧快照整文件覆盖其他进程刚写入的字段（跨进程丢更新）。
 * 修复依据：与 credentialService 相同，让跨进程锁覆盖读取、合并和原子替换的全过程。
 */
async function updateUserCliConfig(
  update: (config: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const filePath = getUserCliConfigPath();
  await withFileLock(filePath, async () => {
    await writeUserCliConfig(update(await readUserCliConfig()));
  });
}

function readCommandEnabledOverrides(config: Record<string, unknown>): Map<string, boolean> {
  const commandConfig = config.command;
  const overrides = new Map<string, boolean>();
  if (!isRecord(commandConfig)) {
    return overrides;
  }

  for (const [filePath, entry] of Object.entries(commandConfig)) {
    if (isRecord(entry) && typeof entry[ENABLE_OVERRIDE_KEY] === "boolean") {
      overrides.set(filePath, entry[ENABLE_OVERRIDE_KEY]);
    }
  }
  return overrides;
}

async function readCommandEnabledOverridesFromUserConfig(): Promise<Map<string, boolean>> {
  return readCommandEnabledOverrides(await readUserCliConfig());
}

function getCommandEnabled(filePath: string, overrides: ReadonlyMap<string, boolean>): boolean {
  return overrides.get(filePath) ?? true;
}

function setCommandEnabledOverride(
  config: Record<string, unknown>,
  filePath: string,
  enabled: boolean,
): Record<string, unknown> {
  const commandConfig = isRecord(config.command) ? { ...config.command } : {};

  if (enabled) {
    delete commandConfig[filePath];
  } else {
    commandConfig[filePath] = { [ENABLE_OVERRIDE_KEY]: false };
  }

  const nextConfig: Record<string, unknown> = { ...config };
  if (Object.keys(commandConfig).length > 0) {
    nextConfig.command = commandConfig;
  } else {
    delete nextConfig.command;
  }
  return nextConfig;
}

function getUserCommandsRootForDescriptor(descriptor: CommandAgentSourceDescriptor): string {
  return join(resolveUserHomeDir(), ...descriptor.userDirectorySegments);
}

function getCommandsRootForStorage(params: {
  descriptor: CommandAgentSourceDescriptor;
  storageLevel?: "user" | "project";
  workspacePath?: string;
}): {
  commandsRoot: string;
  scope: UserCommand["scope"];
  projectPath?: string;
} {
  if (params.storageLevel === "project") {
    if (!params.workspacePath) {
      throw new Error("Missing workspace path for project command");
    }
    return {
      commandsRoot: join(params.workspacePath, ...params.descriptor.workspaceDirectorySegments),
      scope: "project",
      projectPath: params.workspacePath,
    };
  }

  return {
    commandsRoot: getUserCommandsRootForDescriptor(params.descriptor),
    scope: "global",
  };
}

function getLocationScope(scope: UserCommand["scope"]): SettingsDirectoryLocation["scope"] {
  return scope === "project" ? "project" : "user";
}

function buildCommandLocation(params: {
  descriptor: CommandAgentSourceDescriptor;
  commandsRoot: string;
  scope: UserCommand["scope"];
  projectPath?: string;
}): SettingsDirectoryLocation {
  return {
    source: params.descriptor.directorySource,
    scope: getLocationScope(params.scope),
    directoryPath: params.commandsRoot,
    ...(params.projectPath ? { projectPath: params.projectPath } : {}),
  };
}

// ============================================================================
// CommandsService 实现
// ============================================================================

interface CommandsServiceOptions {
  isDesktopRuntime?: boolean;
}

function getCommandName(
  rootDir: string,
  filePath: string,
  descriptor: CommandAgentSourceDescriptor,
): string {
  const relativePath = relative(rootDir, filePath);
  const extensionPattern = new RegExp(`${descriptor.fileExtension.replace(".", "\\.")}$`, "i");
  const withoutExtension = relativePath.replace(extensionPattern, "");
  return `/${withoutExtension
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(descriptor.namespaceSeparator)}`;
}

function getCommandFileName(config: CommandConfig, agentSource: CommandAgentSource): string {
  const descriptor = getCommandSourceDescriptor(agentSource);
  const rawName = config.name.replace(/^\//, "");
  const relativeName = descriptor.namespaceSeparator === ":" ? rawName.replace(/:/g, "/") : rawName;
  return `${relativeName}${descriptor.fileExtension}`;
}

function getWritableCommandConfig(
  config: CommandConfig,
  descriptor: CommandAgentSourceDescriptor,
): CommandConfig {
  return descriptor.supportsArgumentHint ? config : { ...config, argumentHint: undefined };
}

function getCommandAgentSources(agentSource?: CommandAgentSource): readonly CommandAgentSource[] {
  return agentSource ? [agentSource] : COMMAND_AGENT_SOURCE_ORDER;
}

function buildCommandId(
  agentSource: CommandAgentSource,
  scope: UserCommand["scope"],
  name: string,
  location: SettingsDirectoryLocation,
): string {
  return `${agentSource}:${location.source}:${scope}:${name}`;
}

export function createCommandsService(_options?: CommandsServiceOptions): ICommandsService {
  async function list(params: {
    agentSource?: CommandAgentSource;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<CommandsListResult> {
    const userCommands: UserCommand[] = [];
    const agentSources = getCommandAgentSources(params.agentSource);
    const enabledOverrides = await readCommandEnabledOverridesFromUserConfig();

    // ZCode Agent 需要先合并所有 workspace 目录，再合并所有 user 目录；
    // 按每个目录交错读取 project/user 会让 user .zcodium 抢在 workspace .agents 前面。
    for (const agentSource of agentSources) {
      const descriptors =
        agentSource === ZCODE_COMMAND_AGENT_SOURCE
          ? COMMAND_DIRECTORY_SOURCE_DESCRIPTORS
          : [getCommandSourceDescriptor(agentSource)];

      if (params.workspacePath) {
        const workspacePath = params.workspacePath;
        await discoverCommandsFromDirectorySources({
          descriptors,
          commandsRootForDescriptor: (descriptor) =>
            join(workspacePath, ...descriptor.workspaceDirectorySegments),
          commands: userCommands,
          enabledOverrides,
          projectPath: workspacePath,
          scope: "project",
        });
      }

      await discoverCommandsFromDirectorySources({
        descriptors,
        commandsRootForDescriptor: getUserCommandsRootForDescriptor,
        commands: userCommands,
        enabledOverrides,
        scope: "global",
      });
    }

    const dedupedUserCommands = dedupeCommandsByName(userCommands);

    return {
      commands: dedupedUserCommands,
      userCommands: dedupedUserCommands,
      capability: { userScopeAvailable: true },
    };
  }

  async function writeCommandFile(params: CommandCreateParams): Promise<{ command: UserCommand }> {
    const agentSource = params.agentSource ?? DEFAULT_COMMAND_AGENT_SOURCE;
    const descriptor = getCommandSourceDescriptor(agentSource);
    const target = getCommandsRootForStorage({
      descriptor,
      storageLevel: params.storageLevel,
      workspacePath: params.workspacePath,
    });
    const { commandsRoot } = target;
    await mkdir(commandsRoot, { recursive: true });

    const fileName = getCommandFileName(params.config, agentSource);
    const filePath = join(commandsRoot, fileName);

    // 检查文件是否已存在
    try {
      await access(filePath);
      throw new Error(`Command file already exists: ${fileName}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }

    const content = CommandFileParser.generateCommandFileContent(
      getWritableCommandConfig(params.config, descriptor),
      descriptor.format,
    );
    await writeFile(filePath, content, "utf-8");
    await updateUserCliConfig((config) => setCommandEnabledOverride(config, filePath, true));

    const parsed = CommandFileParser.parseCommandFile(content, filePath, descriptor.format);
    if (!parsed) {
      throw new Error("Failed to parse written command file");
    }
    const name = getCommandName(commandsRoot, filePath, descriptor);

    const location = buildCommandLocation({
      descriptor,
      commandsRoot,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    });
    const command: UserCommand = {
      ...parsed,
      name,
      agentSource,
      location,
      id: buildCommandId(agentSource, target.scope, name, location),
      source: "user",
      enabled: true,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    };

    return { command };
  }

  async function updateCommandFile(params: CommandUpdateParams): Promise<{ command: UserCommand }> {
    const agentSource = params.agentSource ?? DEFAULT_COMMAND_AGENT_SOURCE;
    const descriptor = getCommandSourceDescriptor(agentSource);
    const target = getCommandsRootForStorage({
      descriptor,
      storageLevel: params.storageLevel,
      workspacePath: params.workspacePath,
    });
    const { commandsRoot } = target;
    const newFileName = getCommandFileName(params.config, agentSource);
    const newFilePath = join(commandsRoot, newFileName);
    const enabledOverrides = await readCommandEnabledOverridesFromUserConfig();
    const existingContent = params.oldFilePath
      ? await readFile(params.oldFilePath, "utf-8").catch(() => undefined)
      : undefined;

    // 如果文件名变了，需要删除旧文件
    if (params.oldFilePath && params.oldFilePath !== newFilePath) {
      try {
        await rm(params.oldFilePath);
      } catch {
        // 旧文件可能已被移除，忽略删除失败（ENOENT 属正常情况）。
      }
    }

    // 检查新文件是否已存在（排除自己的旧路径）
    if (newFilePath !== params.oldFilePath) {
      try {
        await access(newFilePath);
        throw new Error(`Command file already exists: ${newFileName}`);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }
    }

    const content = CommandFileParser.generateCommandFileContent(
      getWritableCommandConfig(params.config, descriptor),
      descriptor.format,
      existingContent,
    );
    await mkdir(dirname(newFilePath), { recursive: true });
    await writeFile(newFilePath, content, "utf-8");

    if (
      params.oldFilePath &&
      params.oldFilePath !== newFilePath &&
      enabledOverrides.has(params.oldFilePath)
    ) {
      // 禁用状态按命令文件路径存放；编辑命令改名会换文件路径，必须迁移 override，
      // 否则用户刚禁用的命令会因为改名重新启用。迁移是 config 的纯函数，放进锁内基于最新值计算，
      // 避免用锁外旧快照整文件写回。
      const previousFilePath = params.oldFilePath;
      const previousEnabled = enabledOverrides.get(previousFilePath) ?? true;
      await updateUserCliConfig((config) =>
        setCommandEnabledOverride(
          setCommandEnabledOverride(config, previousFilePath, true),
          newFilePath,
          previousEnabled,
        ),
      );
    }

    const parsed = CommandFileParser.parseCommandFile(content, newFilePath, descriptor.format);
    if (!parsed) {
      throw new Error("Failed to parse written command file");
    }
    const name = getCommandName(commandsRoot, newFilePath, descriptor);

    const location = buildCommandLocation({
      descriptor,
      commandsRoot,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    });
    const command: UserCommand = {
      ...parsed,
      name,
      agentSource,
      location,
      id: buildCommandId(agentSource, target.scope, name, location),
      source: "user",
      enabled: getCommandEnabled(newFilePath, await readCommandEnabledOverridesFromUserConfig()),
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    };

    return { command };
  }

  async function deleteCommandFile(params: CommandDeleteParams): Promise<void> {
    try {
      await rm(params.filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        // 文件不存在，当作成功
      } else {
        throw error;
      }
    }
    await updateUserCliConfig((config) => setCommandEnabledOverride(config, params.filePath, true));
  }

  async function setCommandEnabled(params: CommandSetEnabledParams): Promise<void> {
    await updateUserCliConfig((config) =>
      setCommandEnabledOverride(config, params.filePath, params.enabled),
    );
  }

  async function getPrimaryUserCommandsDirectory(params?: {
    agentSource?: CommandAgentSource;
  }): Promise<{ path: string }> {
    const path = getUserCommandsRoot(params?.agentSource);
    // open-in-file-manager 在 Windows 上不能可靠打开不存在的路径，
    // 这里先确保命令目录落盘，再把路径交给系统文件管理器。
    await mkdir(path, { recursive: true });
    return { path };
  }

  return {
    list,
    writeCommandFile,
    updateCommandFile,
    deleteCommandFile,
    setCommandEnabled,
    getPrimaryUserCommandsDirectory,
  };
}

function dedupeCommandsByName(commands: UserCommand[]): UserCommand[] {
  const selected = new Map<string, UserCommand>();
  for (const command of commands) {
    if (!selected.has(command.name)) {
      selected.set(command.name, command);
    }
  }
  return Array.from(selected.values());
}

// ============================================================================
// 辅助函数
// ============================================================================

async function discoverUserCommandsRecursive(
  rootDir: string,
  currentDir: string,
  commands: UserCommand[],
  options: {
    descriptor: CommandAgentSourceDescriptor;
    scope: UserCommand["scope"];
    enabledOverrides: ReadonlyMap<string, boolean>;
    projectPath?: string;
  },
): Promise<void> {
  const descriptor = options.descriptor;
  let entries: string[];
  try {
    entries = await readdir(currentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry);

    // 跳过隐藏文件和目录
    if (entry.startsWith(".")) {
      continue;
    }

    let isDir = false;
    try {
      const stat = await lstat(fullPath);
      isDir = stat.isDirectory();
    } catch {
      // 无法访问，跳过
      continue;
    }

    if (isDir) {
      // 递归扫描子目录
      await discoverUserCommandsRecursive(rootDir, fullPath, commands, options);
      continue;
    }

    if (entry.toLowerCase().endsWith(descriptor.fileExtension)) {
      try {
        const content = await readFile(fullPath, "utf-8");
        const parsed = CommandFileParser.parseCommandFile(content, fullPath, descriptor.format);
        if (parsed) {
          const name = getCommandName(rootDir, fullPath, descriptor);
          const location = buildCommandLocation({
            descriptor,
            commandsRoot: rootDir,
            scope: options.scope,
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
          });
          commands.push({
            ...parsed,
            name,
            agentSource: descriptor.agentSource,
            location,
            id: buildCommandId(descriptor.agentSource, options.scope, name, location),
            source: "user",
            enabled: getCommandEnabled(fullPath, options.enabledOverrides),
            scope: options.scope,
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
          });
        }
      } catch {
        // 解析失败就跳过
      }
    }
  }
}

async function discoverCommandsRoot(params: {
  descriptor: CommandAgentSourceDescriptor;
  commandsRoot: string;
  scope: UserCommand["scope"];
  commands: UserCommand[];
  enabledOverrides: ReadonlyMap<string, boolean>;
  projectPath?: string;
}): Promise<number> {
  const beforeCount = params.commands.length;
  try {
    await access(params.commandsRoot);
  } catch {
    return 0;
  }

  try {
    await discoverUserCommandsRecursive(params.commandsRoot, params.commandsRoot, params.commands, {
      descriptor: params.descriptor,
      scope: params.scope,
      enabledOverrides: params.enabledOverrides,
      ...(params.projectPath ? { projectPath: params.projectPath } : {}),
    });
  } catch {
    // 扫描出错时返回已发现的命令
  }
  return params.commands.length - beforeCount;
}

async function discoverCommandsFromDirectorySources(params: {
  descriptors: readonly CommandAgentSourceDescriptor[];
  commandsRootForDescriptor: (descriptor: CommandAgentSourceDescriptor) => string;
  scope: UserCommand["scope"];
  commands: UserCommand[];
  enabledOverrides: ReadonlyMap<string, boolean>;
  projectPath?: string;
}): Promise<void> {
  for (const descriptor of params.descriptors) {
    const discoveredCount = await discoverCommandsRoot({
      descriptor,
      commandsRoot: params.commandsRootForDescriptor(descriptor),
      commands: params.commands,
      enabledOverrides: params.enabledOverrides,
      scope: params.scope,
      ...(params.projectPath ? { projectPath: params.projectPath } : {}),
    });
    // `.zcodium` 是强优先级来源；只要读到有效命令，同 scope 的 `.agents` 就不再参与。
    if (descriptor.directorySource === "zcode" && discoveredCount > 0) {
      break;
    }
  }
}
