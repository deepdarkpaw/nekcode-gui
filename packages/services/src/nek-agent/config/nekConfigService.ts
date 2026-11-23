import { isAgentPresetFileName } from "@zcode/shared/nek-protocol";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  parseWithSchema,
  nekMcpFileSchema,
  nekMcpOverrideSchema,
  nekMcpServerSchema,
  nekSettingsFileSchema,
  nekYamlSchema,
  NEK_MCP_OVERRIDE_KEYS,
  NEK_MCP_SERVER_NAME_PATTERN,
} from "./schemas.js";
import type { NekMcpFile, NekMcpServer, NekSettingsFile, NekYamlConfig } from "./schemas.js";
import type { NekConfigFs, NekConfigRevision } from "./nekConfigFs.js";
import { decodeAgentFrontmatter, parseAgentMarkdown } from "./agentPresetFrontmatter.js";
import {
  formatIssue,
  isPlainObject,
  mergeSettingsPatch,
  parseJsonObject,
  serializeFrontmatterDocument,
  stripBom,
} from "./nekConfigDocuments.js";
import {
  assertRevision,
  atomicWrite,
  NekConfigConflictError,
  NekConfigParseError,
  readSnapshot,
  revisionOf,
  sameRevision,
} from "./nekConfigFs.js";

/**
 * `~/.nek/agent` 与项目 `.nek/` 的读写服务（不含 models.json，那部分在 `nekConfigModels.ts`）。
 *
 * 三条硬规则（ARD §3）：
 * 1. `settings.json` 与 nek 共用同一把 `proper-lockfile` 锁，且**只合并改动过的字段**：
 *    整文件覆盖会把 nek 在另一个进程里刚写的字段抹掉；
 * 2. 其它文件用 `.tmp` + rename 原子写；
 * 3. 读取返回 revision（mtime + size + hash），写入时 revision 变了就拒绝并提示"外部已修改"。
 */

export type NekConfigScope = "global" | "project";

export interface NekConfigPaths {
  /** `~/.nek/agent`（可被 `NEK_CODING_AGENT_DIR` 覆盖）。 */
  agentDir: string;
  /** `<cwd>/.nek`。 */
  projectDir: string;
}

export interface NekConfigDocument<T> {
  path: string;
  data: T;
  /** null = 文件不存在（首次创建）。 */
  revision: NekConfigRevision | null;
  raw: string | null;
}

export interface NekAgentPresetDocument {
  name: string;
  scope: NekConfigScope;
  path: string;
  frontmatter: Record<string, unknown> & { name: string; description: string; model?: string };
  body: string;
  revision: NekConfigRevision & { path: string };
}

export interface NekConfigServiceOptions {
  paths: NekConfigPaths;
  fs: NekConfigFs;
  logger?: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
}

/** 解析配置目录：`agentDir` 走环境变量覆盖，项目目录固定为 `<cwd>/.nek`。 */
export function resolveNekConfigPaths(args: {
  cwd: string;
  env?: Record<string, string | undefined>;
  home?: string;
}): NekConfigPaths {
  const env = args.env ?? process.env;
  const home = args.home ?? homedir();
  const configured = env.NEK_CODING_AGENT_DIR?.trim();
  const agentDir =
    configured && configured !== "" ? expandTilde(configured, home) : join(home, ".nek", "agent");
  return { agentDir, projectDir: join(args.cwd, ".nek") };
}

function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

export class NekConfigService {
  constructor(private readonly options: NekConfigServiceOptions) {}

  get paths(): NekConfigPaths {
    return this.options.paths;
  }

  private get fs(): NekConfigFs {
    return this.options.fs;
  }

  /** `settings.json` 的路径（global / project）。 */
  settingsPath(scope: NekConfigScope = "global"): string {
    return scope === "global"
      ? join(this.paths.agentDir, "settings.json")
      : join(this.paths.projectDir, "settings.json");
  }

  mcpPath(scope: NekConfigScope = "global"): string {
    return scope === "global"
      ? join(this.paths.agentDir, "mcp.json")
      : join(this.paths.projectDir, "mcp.json");
  }

  nekYamlPath(scope: NekConfigScope = "global"): string {
    return scope === "global"
      ? join(this.paths.agentDir, "nek.yaml")
      : join(this.paths.projectDir, "nek.yaml");
  }

  private agentPresetDirectory(scope: NekConfigScope): string {
    return join(scope === "global" ? this.paths.agentDir : this.paths.projectDir, "agents");
  }

  globalAgentsMdPath(): string {
    return join(this.paths.agentDir, "AGENTS.md");
  }

  // --------------------------------------------------------------------------
  // settings.json
  // --------------------------------------------------------------------------

  async readSettings(
    scope: NekConfigScope = "global",
  ): Promise<NekConfigDocument<NekSettingsFile>> {
    const path = this.settingsPath(scope);
    const snapshot = await readSnapshot(this.fs, path);
    if (!snapshot) {
      return { path, data: {}, revision: null, raw: null };
    }
    const parsed = parseJsonObject(path, snapshot.content);
    return {
      path,
      data: parsed as NekSettingsFile,
      revision: revisionOf(snapshot),
      raw: snapshot.content,
    };
  }

  /**
   * 只合并改动字段。
   *
   * 整个读改写发生在 nek 的同一把锁里：`expectedRevision` 也在锁内比对，
   * 所以"外部改了 settings"和"我们要写"之间不会被别的进程插进来。
   */
  async patchSettings(
    patch: Partial<Record<string, unknown>>,
    options: {
      scope?: NekConfigScope;
      expectedRevision?: NekConfigRevision | null;
      /** 这些顶层键整体替换（例如改名后键集合变了，必须丢掉旧键）。 */
      replaceKeys?: readonly string[];
    } = {},
  ): Promise<NekConfigDocument<NekSettingsFile>> {
    const scope = options.scope ?? "global";
    const path = this.settingsPath(scope);
    this.fs.lock.run(path, (current) => {
      const parsed =
        current === undefined || current.trim() === "" ? {} : parseJsonObject(path, current);
      if (options.expectedRevision !== undefined) {
        // revision 在锁内比对：锁外的读-比-写会被另一个进程的写入插进来。
        const actual =
          current === undefined
            ? null
            : revisionOf({
                content: current,
                mtimeMs: 0,
                size: Buffer.byteLength(current, "utf8"),
              });
        if (!sameRevision(actual, options.expectedRevision)) {
          throw new NekConfigConflictError(path, options.expectedRevision, actual);
        }
      }
      const merged = mergeSettingsPatch(parsed, patch, options.replaceKeys ?? []);
      return `${JSON.stringify(merged, null, 2)}\n`;
    });
    return await this.readSettings(scope);
  }

  // --------------------------------------------------------------------------
  // mcp.json
  // --------------------------------------------------------------------------

  async readMcp(scope: NekConfigScope = "global"): Promise<NekConfigDocument<NekMcpFile>> {
    const path = this.mcpPath(scope);
    const snapshot = await readSnapshot(this.fs, path);
    if (!snapshot) return { path, data: { mcpServers: {} }, revision: null, raw: null };
    const parsed = parseJsonObject(path, snapshot.content);
    const validated = parseWithSchema(nekMcpFileSchema, parsed);
    if (!validated.ok)
      throw new NekConfigParseError(path, validated.issues.map(formatIssue).join("; "));
    return { path, data: validated.data, revision: revisionOf(snapshot), raw: snapshot.content };
  }

  /** 增/改一个 MCP server。项目级只允许写 `enabled` / `exposure` / `toolExposure`。 */
  async upsertMcpServer(
    name: string,
    server: NekMcpServer,
    options: { scope?: NekConfigScope; expectedRevision?: NekConfigRevision | null } = {},
  ): Promise<NekConfigDocument<NekMcpFile>> {
    const scope = options.scope ?? "global";
    if (!NEK_MCP_SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`invalid MCP server name "${name}" (use letters, digits, "_" and "-")`);
    }
    const schema = scope === "project" ? nekMcpOverrideSchema : nekMcpServerSchema;
    const validated = parseWithSchema(schema, server);
    if (!validated.ok) {
      throw new Error(
        `invalid MCP server "${name}": ${validated.issues.map(formatIssue).join("; ")}`,
      );
    }
    if (scope === "project") {
      const extra = Object.keys(validated.data as Record<string, unknown>).filter(
        (key) => !(NEK_MCP_OVERRIDE_KEYS as readonly string[]).includes(key),
      );
      if (extra.length > 0) {
        throw new Error(
          `project mcp.json can only set ${NEK_MCP_OVERRIDE_KEYS.join(", ")} for "${name}", got ${extra.join(", ")}`,
        );
      }
    }
    const current = await this.readMcp(scope);
    this.assertExpected(current.revision, options.expectedRevision);
    const next: NekMcpFile = {
      ...current.data,
      mcpServers: { ...current.data.mcpServers, [name]: validated.data },
    };
    await atomicWrite(this.fs, current.path, `${JSON.stringify(next, null, 2)}\n`);
    return await this.readMcp(scope);
  }

  async removeMcpServer(
    name: string,
    options: { scope?: NekConfigScope; expectedRevision?: NekConfigRevision | null } = {},
  ): Promise<NekConfigDocument<NekMcpFile>> {
    const scope = options.scope ?? "global";
    const current = await this.readMcp(scope);
    if (current.data.mcpServers[name] === undefined) return current;
    this.assertExpected(current.revision, options.expectedRevision);
    const servers = { ...current.data.mcpServers };
    delete servers[name];
    await atomicWrite(
      this.fs,
      current.path,
      `${JSON.stringify({ ...current.data, mcpServers: servers }, null, 2)}\n`,
    );
    return await this.readMcp(scope);
  }

  // --------------------------------------------------------------------------
  // nek.yaml
  // --------------------------------------------------------------------------

  async readNekYaml(scope: NekConfigScope = "global"): Promise<NekConfigDocument<NekYamlConfig>> {
    const path = this.nekYamlPath(scope);
    const snapshot = await readSnapshot(this.fs, path);
    if (!snapshot) return { path, data: {}, revision: null, raw: null };
    let parsed: unknown;
    try {
      parsed = parseYaml(stripBom(snapshot.content));
    } catch (error) {
      throw new NekConfigParseError(path, error instanceof Error ? error.message : String(error));
    }
    if (parsed === null || parsed === undefined)
      return { path, data: {}, revision: revisionOf(snapshot), raw: snapshot.content };
    if (!isPlainObject(parsed))
      throw new NekConfigParseError(path, "expected a mapping at the top level");
    const validated = parseWithSchema(nekYamlSchema, parsed);
    if (!validated.ok)
      throw new NekConfigParseError(path, validated.issues.map(formatIssue).join("; "));
    return { path, data: validated.data, revision: revisionOf(snapshot), raw: snapshot.content };
  }

  /** nek.yaml 的补丁：与 settings 同样的"只合并改动字段"语义（顶层键、子键）。 */
  async patchNekYaml(
    patch: Record<string, unknown>,
    options: { scope?: NekConfigScope; expectedRevision?: NekConfigRevision | null } = {},
  ): Promise<NekConfigDocument<NekYamlConfig>> {
    const scope = options.scope ?? "global";
    const current = await this.readNekYaml(scope);
    this.assertExpected(current.revision, options.expectedRevision);
    const merged = mergeSettingsPatch(current.data as Record<string, unknown>, patch);
    await atomicWrite(this.fs, current.path, stringifyYaml(merged));
    return await this.readNekYaml(scope);
  }

  // --------------------------------------------------------------------------
  // agents/*.md
  // --------------------------------------------------------------------------

  /** Legacy provider-reference enumeration also uses the YAML name, never the file stem. */
  async listAgentPresets(): Promise<NekAgentPresetDocument[]> {
    return [
      ...(await this.listPresetsInScope("global")),
      ...(await this.listPresetsInScope("project")),
    ];
  }

  private async listPresetsInScope(scope: NekConfigScope): Promise<NekAgentPresetDocument[]> {
    const dir = this.agentPresetDirectory(scope);
    const names = (await this.fs.listDir(dir)).filter((name) => name.endsWith(".md"));
    const presets: NekAgentPresetDocument[] = [];
    for (const filename of names) {
      const path = join(dir, filename);
      try {
        const preset = await this.readAgentPresetFile(path, scope);
        if (preset) presets.push(preset);
      } catch (error) {
        this.options.logger?.warn("skipping unreadable agent preset", path, error);
      }
    }
    return presets;
  }

  private async readAgentPresetFile(
    path: string,
    scope: NekConfigScope,
  ): Promise<NekAgentPresetDocument | null> {
    const snapshot = await readSnapshot(this.fs, path);
    if (!snapshot) return null;
    const { frontmatter, bodySuffix, preset } = parseAgentMarkdown(path, snapshot.content);
    const { name, description, model } = preset;
    return {
      name,
      scope,
      path,
      frontmatter: { ...frontmatter, name, description, model },
      body: bodySuffix.replace(/^\r?\n/u, ""),
      revision: { ...revisionOf(snapshot), path },
    };
  }

  async readAgentPreset(
    name: string,
    scope: NekConfigScope = "global",
  ): Promise<NekAgentPresetDocument | null> {
    const matches = (await this.listPresetsInScope(scope)).filter((preset) => preset.name === name);
    if (matches.length > 1)
      throw new Error(
        `Multiple preset files define ${name}: ${matches.map((preset) => preset.path).join(", ")}`,
      );
    return matches[0] ?? null;
  }

  /** Write back a resolved preset at its original path; only a new preset derives a filename. */
  async writeAgentPreset(
    preset: { name: string; frontmatter: Record<string, unknown>; body?: string },
    options: { scope?: NekConfigScope; expectedRevision?: NekConfigRevision | null } = {},
  ): Promise<NekAgentPresetDocument> {
    const scope = options.scope ?? "global";
    const dir = this.agentPresetDirectory(scope);
    const { name } = decodeAgentFrontmatter(dir, preset.frontmatter);
    const existing = await this.readAgentPreset(preset.name, scope);
    if (!existing && !isAgentPresetFileName(name))
      throw new Error(`invalid agent preset name "${name}"`);
    const path = existing?.path ?? join(dir, `${name}.md`);
    await assertRevision(this.fs, path, options.expectedRevision ?? existing?.revision ?? null);
    await atomicWrite(
      this.fs,
      path,
      serializeFrontmatterDocument(preset.frontmatter, preset.body ?? ""),
    );
    const written = await this.readAgentPresetFile(path, scope);
    if (!written) throw new NekConfigParseError(path, "file disappeared right after writing");
    return written;
  }

  async deleteAgentPreset(
    name: string,
    options: { scope?: NekConfigScope; expectedRevision?: NekConfigRevision | null } = {},
  ): Promise<boolean> {
    const existing = await this.readAgentPreset(name, options.scope);
    if (!existing) return false;
    await assertRevision(this.fs, existing.path, options.expectedRevision ?? existing.revision);
    await this.fs.remove(existing.path);
    return true;
  }

  // --------------------------------------------------------------------------
  // 全局 AGENTS.md
  // --------------------------------------------------------------------------

  async readGlobalAgentsMd(): Promise<NekConfigDocument<string>> {
    const path = this.globalAgentsMdPath();
    const snapshot = await readSnapshot(this.fs, path);
    if (!snapshot) return { path, data: "", revision: null, raw: null };
    return { path, data: snapshot.content, revision: revisionOf(snapshot), raw: snapshot.content };
  }

  async writeGlobalAgentsMd(
    content: string,
    options: { expectedRevision?: NekConfigRevision | null } = {},
  ): Promise<NekConfigDocument<string>> {
    const path = this.globalAgentsMdPath();
    await assertRevision(this.fs, path, options.expectedRevision);
    await atomicWrite(this.fs, path, content);
    return await this.readGlobalAgentsMd();
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private assertExpected(
    actual: NekConfigRevision | null,
    expected?: NekConfigRevision | null,
  ): void {
    if (expected === undefined) return;
    if (!sameRevision(actual, expected))
      throw new NekConfigConflictError(this.paths.agentDir, expected, actual);
  }
}

/** 供设置页校验整份 settings.json（读写本身不做类型校验，避免把 nek 写出的合法值挡在外面）。 */
export function validateSettingsDocument(value: unknown): Array<{ path: string; message: string }> {
  const validated = parseWithSchema(nekSettingsFileSchema, value);
  return validated.ok ? [] : validated.issues;
}

export { NekConfigParseError };
