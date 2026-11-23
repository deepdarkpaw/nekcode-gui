export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildPosixShellExecCommand(command: string): string {
  return `/bin/sh -c ${quotePosixShellArg(command)}`;
}

/**
 * 在远端用户的登录 shell 里执行 `command`，与远端 gui-server 采集登录环境的规则一致
 * （`runtimeLoginShellEnvCapture`）：bash / zsh 以交互式登录 shell 运行，因为 nvm 和自装 Node
 * 常写在 `~/.bashrc` / `~/.zshrc` 的交互段，非交互 `sh -l` 读不到；fish 用自己的登录 shell；
 * 其余 shell 用 POSIX `sh -l`。`command` 必须是 POSIX 与 fish 都能解析的简单命令（单引号参数）。
 */
export function buildLoginShellCommand(command: string): string {
  const quoted = quotePosixShellArg(command);
  return [
    'case "${SHELL:-}" in',
    `*/bash|*/zsh) exec "$SHELL" -ilc ${quoted} ;;`,
    `*/fish) exec "$SHELL" -lc ${quoted} ;;`,
    `*) exec /bin/sh -lc ${quoted} ;;`,
    "esac",
  ].join("\n");
}

export function quotePosixPathArg(path: string): string {
  if (path === "~") {
    return '"$HOME"';
  }

  if (path.startsWith("~/")) {
    return `"$HOME"${quotePosixShellArg(path.slice(1))}`;
  }

  return quotePosixShellArg(path);
}

export function resolvePosixHomePath(remotePath: string, homeDir: string): string {
  if (remotePath === "~") {
    return homeDir;
  }

  if (remotePath.startsWith("~/")) {
    return `${homeDir.replace(/\/$/, "")}/${remotePath.slice(2)}`;
  }

  return remotePath;
}

export function buildWriteLiteralFileCommand(targetPath: string, content: string): string {
  return `printf %s ${quotePosixShellArg(content)} > ${quotePosixPathArg(targetPath)}`;
}
