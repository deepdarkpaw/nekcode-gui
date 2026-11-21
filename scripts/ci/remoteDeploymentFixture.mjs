import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";
import { bundleRemoteAssets } from "../bundle-remote-assets.mjs";
import { createRemoteAssetFixture } from "./remoteAssetsFixture.mjs";

const { ZCODE_VERSION: version } = await tsImport("@zcode/shared", import.meta.url);
const { deployServer } = await tsImport(
  "../../packages/server/src/remote/deploy.ts",
  import.meta.url,
);
const { acquireRemoteDeployLock } = await tsImport(
  "../../packages/server/src/remote/remoteDeployLock.ts",
  import.meta.url,
);
const { quotePosixShellArg } = await tsImport(
  "../../packages/server/src/remote/posixShell.ts",
  import.meta.url,
);

const environment = { platform: "linux", arch: "x64" };
const tools = [
  "awk",
  "base64",
  "cat",
  "chmod",
  "date",
  "gzip",
  "head",
  "hostname",
  "mkdir",
  "mv",
  "rm",
  "sha256sum",
  "sh",
  "sleep",
  "stat",
  "tar",
  "timeout",
  "tr",
];

function findTestShell() {
  if (process.platform === "linux") return "/bin/sh";
  if (process.platform !== "win32") return undefined;
  // Windows 本地验证复用开发环境的 Git Bash；CI 不需要额外安装任何 shell。
  try {
    const [path] = execFileSync("where.exe", ["sh"], { encoding: "utf8" }).trim().split(/\r?\n/u);
    return path;
  } catch {
    return undefined;
  }
}

const shell = findTestShell();
export const hasTestShell = shell !== undefined;
const posixPath = (path) => path.replaceAll("\\", "/");

export function contentForPath(id, path) {
  if (id === "node-runtime" && path === "node")
    return `#!/bin/sh\nexec ${quotePosixShellArg(posixPath(process.execPath))} "$@"\n`;
  if (id === "server-bundle")
    return `// skill-sync mcp-sync plugin-sync __zcode_rpc_nested_uint8array_v1 exportMarketplaceSourceArchive importMarketplaceSourceArchive\nrequire("fs").writeSync(1, ${JSON.stringify(version)});`;
  return "fixture";
}

async function writeTool(bin, name, script) {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\nset -eu\n${script}\n`);
  await chmod(path, 0o755);
}

async function writeFakeDownloader(bin, data, downloader, behavior, fetchLog) {
  const reportStatus =
    downloader === "curl" ? 'printf "%s" "$1"' : 'printf "  HTTP/1.1 %s test\\n" "$1" >&2';
  const lowSpeed =
    "curl: (28) Operation too slow. Less than 32768 bytes/sec transferred the last 20 seconds";
  const readTimeout = "Read error at byte 10/100 (Connection timed out). Giving up.";
  const body = {
    404: `printf '%s' partial > "$out"; status 404; exit ${downloader === "curl" ? 22 : 8}`,
    tampered: 'printf %s tampered > "$out"; status 200; exit 0',
    cancel: 'printf %s partial > "$out"; exec sleep 20',
    stalled:
      downloader === "curl"
        ? `status 200; printf '%s\\n' '${lowSpeed}' >&2; exit 28`
        : `status 200; printf '%s\\n' '${readTimeout}' >&2; exit 4`,
    "busybox-stalled": "status 200; printf '%s\\n' 'wget: download timed out' >&2; exit 1",
    timeout:
      downloader === "curl"
        ? `status 200; printf '%s\\n' '${lowSpeed}' 'curl: (28) Operation timed out after 61001 milliseconds' >&2; exit 28`
        : `status 200; printf '%s\\n' '${readTimeout}' >&2; exit 124`,
    success: data.manifest.components
      .map(
        ({ id, artifactPath }) => `
      case "$url" in *-linux-x64-${id}.tar.gz)
        cat ${quotePosixShellArg(posixPath(join(data.options.outputDirectory, artifactPath)))} > "$out"
        status 200
        exit 0 ;;
      esac`,
      )
      .join("\n"),
  }[behavior];
  await writeTool(
    bin,
    downloader,
    `
    [ "$HTTPS_PROXY" = fake-proxy ]
    [ "$LC_ALL" = C ]
    ${downloader === "wget" ? '[ "$https_proxy" = fake-proxy ]' : ""}
    if [ "$#" -eq 1 ] && [ "$1" = --version ]; then
      ${behavior === "busybox-stalled" ? "exit 1" : "printf '%s\\n' 'GNU Wget 1.21.3'; exit 0"}
    fi
    status() { ${reportStatus}; }
    out= url=
    while [ "$#" -gt 0 ]; do
      case "$1" in -o|-O) shift; out=$1 ;; https://*) url=$1 ;; esac
      shift
    done
    [ -n "$out" ] && [ -n "$url" ]
    printf '%s\\n' "$url" >> ${quotePosixShellArg(posixPath(fetchLog))}
    ${body}
    exit 2
  `,
  );
}

/** 用实际 POSIX shell、独立 HOME/PATH 与假下载器，脚本不可能访问真实网络。 */
export async function remoteDeploymentFixture(
  t,
  { kind, downloader, behavior = "success", afterUpload } = {},
) {
  const children = new Set();
  // 先注册等待子进程退出的 hook；在 Windows 上仍有 cwd 的目录不能删除。
  t.after(async () => {
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise((resolve) => {
            child.once("close", resolve);
            child.stdin.end();
          }),
      ),
    );
  });
  const data = await createRemoteAssetFixture(t, contentForPath, version);
  await bundleRemoteAssets(data.options);
  const remote = join(data.root, "remote");
  const bin = join(remote, "bin");
  await mkdir(bin, { recursive: true });
  const toolPaths = execFileSync(
    shell,
    ["-c", tools.map((tool) => `command -v ${tool}`).join("\n")],
    {
      encoding: "utf8",
    },
  )
    .trim()
    .split(/\r?\n/u);
  assert.equal(toolPaths.length, tools.length);
  await Promise.all(
    tools.map((tool, i) => writeTool(bin, tool, `exec ${quotePosixShellArg(toolPaths[i])} "$@"`)),
  );
  const fetchLog = join(remote, "requests.txt");
  await writeFile(fetchLog, "");
  if (downloader) await writeFakeDownloader(bin, data, downloader, behavior, fetchLog);

  const uploads = [];
  const commands = [];
  const remoteHome =
    process.platform === "win32"
      ? execFileSync(shell, ["-c", `cygpath -u ${quotePosixShellArg(posixPath(remote))}`], {
          encoding: "utf8",
        }).trim()
      : remote;
  const realPath = (value) => (value.startsWith("~/") ? join(remote, value.slice(2)) : value);
  const backend = {
    kind,
    async upload(from, to) {
      uploads.push(to);
      await copyFile(from, realPath(to));
      await afterUpload?.(realPath(to));
    },
    async exec(command) {
      commands.push(command);
      // 用文件保留字面量，避免 Windows 的 argv 再转义；stdin 留给锁释放和取消。
      const scriptFile = `./exec-${commands.length}.sh`;
      // MSYS 不实现 RLIMIT_FSIZE，Linux 跑真正的限额；两者都经过实际 SHA 校验。
      const limit =
        process.platform === "win32" ? 'ulimit() { [ "$1" = -f ] && [ "$2" -gt 0 ]; }\n' : "";
      await writeFile(
        join(remote, scriptFile),
        `PATH=./bin; export PATH HOME=${quotePosixShellArg(remoteHome)}\n${limit}${command}`,
      );
      const child = spawn(shell, [scriptFile], {
        cwd: remote,
        env: { ...process.env, https_proxy: undefined, HTTPS_PROXY: "fake-proxy" },
        windowsHide: true,
      });
      children.add(child);
      // 取消等待者时可能已关闭 stdin；收口仍由 child close 驱动。
      child.stdin.on("error", () => {});
      child.once("close", () => children.delete(child));
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        // 模拟不支持 signal 的 sshd，下载脚本必须能用 stdin EOF 自行停止。
        onClose(listener) {
          const handleClose = (code) => listener(code ?? -1);
          child.once("close", handleClose);
          return { dispose: () => child.off("close", handleClose) };
        },
      };
    },
  };
  return {
    ...data,
    remote,
    backend,
    uploads,
    commands,
    acquireLock: () => acquireRemoteDeployLock(backend),
    requests: async () => (await readFile(fetchLog, "utf8")).trim().split(/\r?\n/u).filter(Boolean),
    installed: (value) => join(remote, ".nek/gui-server", value),
    deploy: (options = {}, target = environment) =>
      deployServer(backend, target, {
        bundledRemoteAssetsDir: data.options.outputDirectory,
        ...options,
      }),
    version,
  };
}
