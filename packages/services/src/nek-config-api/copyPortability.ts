/**
 * 复制预览的可移植性检查：配置原样写到目标机器，这里找出依赖源机器环境的值。
 *
 * 取值规则与 nek `resolve-config-value.ts` 一致：`!` 开头是命令；否则 `$NAME` / `${NAME}`
 * 是环境变量，`$$`、`$!` 是转义。只报告，不改写——密钥换成字面量还是在目标机器上
 * 设变量，由用户决定。
 */
import type { NekCopyWarning } from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";

const ENV_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** 盘符路径（`C:\`、`C:/`，可出现在 `--config=C:\…` 这类参数中间）与 Windows 可执行文件。 */
const WINDOWS_PATH = /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|\.(?:exe|cmd|bat|ps1)$/iu;

/** 字符串本身、数组里的字符串、对象的字符串值（一层）。 */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  const values = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : [];
  return values.filter((entry): entry is string => typeof entry === "string");
}

/** 一个非命令配置值里引用的环境变量名。 */
function envNamesOf(value: string): string[] {
  const names: string[] = [];
  let index = value.indexOf("$");
  while (index >= 0) {
    const next = value[index + 1];
    let consumed = 1;
    if (next === "$" || next === "!") {
      consumed = 2;
    } else if (next === "{") {
      const end = value.indexOf("}", index + 2);
      const name = end < 0 ? "" : value.slice(index + 2, end);
      if (ENV_NAME.test(name)) {
        names.push(name);
        consumed = end + 1 - index;
      }
    } else {
      const match = ENV_NAME_PREFIX.exec(value.slice(index + 1));
      if (match) {
        names.push(match[0]);
        consumed = 1 + match[0].length;
      }
    }
    index = value.indexOf("$", index + consumed);
  }
  return names;
}

function referenceWarnings(values: readonly string[]): NekCopyWarning[] {
  const warnings: NekCopyWarning[] = [];
  const names = [...new Set(values.filter((value) => !value.startsWith("!")).flatMap(envNamesOf))];
  if (names.length > 0) warnings.push({ kind: "env", names });
  if (values.some((value) => value.startsWith("!"))) warnings.push({ kind: "command" });
  return warnings;
}

/** 服务商：API Key 与服务商 / 模型请求头都按 nek 的取值规则解析。 */
export function providerCopyWarnings(provider: Record<string, unknown>): NekCopyWarning[] {
  const models = Array.isArray(provider.models) ? provider.models.filter(isPlainObject) : [];
  return referenceWarnings([
    ...stringsOf(provider.apiKey),
    ...stringsOf(provider.headers),
    ...models.flatMap((model) => stringsOf(model.headers)),
  ]);
}

/** MCP 服务器：`env` / `headers` 按取值规则解析；目标不是 Windows 时检查 Windows 路径。 */
export function mcpServerCopyWarnings(
  server: Record<string, unknown>,
  targetPlatform: string,
): NekCopyWarning[] {
  const warnings = referenceWarnings([...stringsOf(server.env), ...stringsOf(server.headers)]);
  if (targetPlatform === "win32") return warnings;
  const locations = [
    ...stringsOf(server.command),
    ...stringsOf(server.args),
    ...stringsOf(server.cwd),
    ...stringsOf(server.env),
  ];
  if (locations.some((value) => WINDOWS_PATH.test(value))) warnings.push({ kind: "windowsPath" });
  return warnings;
}
