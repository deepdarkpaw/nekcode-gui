import { gunzip } from "node:zlib";
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, posix } from "node:path";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);
const TAR_BLOCK_SIZE = 512;

// Windows 客户端不一定能 spawn System32\tar.exe，远端资源本地缓存不能依赖系统 tar。
// 这里仅支持 ZCode remote assets 使用的普通文件/目录子集，避免扩大归档格式的行为面。
export async function extractTarGzArchive(archivePath: string, targetDir: string): Promise<void> {
  await extractTarGzBuffer(await readFile(archivePath), targetDir);
}

/** Allows callers to verify and extract exactly the same archive bytes. */
export async function extractTarGzBuffer(bytes: Uint8Array, targetDir: string): Promise<void> {
  const targetRoot = resolve(targetDir);
  await mkdir(targetRoot, { recursive: true });

  const archiveBuffer = await gunzipAsync(bytes);
  let offset = 0;
  let nextEntryName: string | null = null;

  while (offset + TAR_BLOCK_SIZE <= archiveBuffer.length) {
    const header = archiveBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;

    if (isZeroBlock(header)) {
      break;
    }

    const size = parseTarOctal(header, 124, 12);
    const dataStart = offset;
    const dataEnd = dataStart + size;
    if (dataEnd > archiveBuffer.length) {
      throw new Error("[remote-assets] truncated tar entry");
    }

    const data = archiveBuffer.subarray(dataStart, dataEnd);
    offset = dataStart + roundUpToTarBlock(size);

    const typeFlag = readTarTypeFlag(header);
    if (typeFlag === "L") {
      nextEntryName = readTarString(data, 0, data.length);
      continue;
    }
    if (typeFlag === "x" || typeFlag === "g") {
      continue;
    }

    const rawEntryName = nextEntryName ?? readTarEntryPath(header);
    nextEntryName = null;
    const safeEntryPath = normalizeExtractEntryPath(rawEntryName);
    if (!safeEntryPath) {
      continue;
    }

    const targetPath = resolvePathWithinBase(targetRoot, safeEntryPath);
    const mode = parseTarOctal(header, 100, 8);

    if (typeFlag === "5") {
      await mkdir(targetPath, { recursive: true });
      await applyMode(targetPath, mode);
      continue;
    }

    if (typeFlag === "0" || typeFlag === "\0") {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, data);
      await applyMode(targetPath, mode);
      continue;
    }

    if (typeFlag === "2") {
      const linkTarget = normalizeExtractSymlinkTarget({
        rawLinkTarget: readTarString(header, 157, 100),
        targetPath,
        targetRoot,
      });
      await mkdir(dirname(targetPath), { recursive: true });
      await unlinkIfExists(targetPath);
      await symlink(linkTarget, targetPath);
      continue;
    }

    throw new Error(
      `[remote-assets] unsupported tar entry type ${JSON.stringify(typeFlag)} for ${rawEntryName}`,
    );
  }
}

function readTarEntryPath(header: Buffer): string {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function readTarTypeFlag(header: Buffer): string {
  const value = header[156] ?? 0;
  return value === 0 ? "0" : String.fromCharCode(value);
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function parseTarOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = readTarString(buffer, offset, length).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function roundUpToTarBlock(size: number): number {
  return Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}

function normalizeExtractEntryPath(entryPath: string): string | null {
  const trimmed = entryPath.trim().replace(/^\.\/+/u, "");
  if (!trimmed || trimmed === ".") {
    return null;
  }
  if (trimmed.includes("\\") || isAbsolute(trimmed) || posix.isAbsolute(trimmed)) {
    throw new Error(`[remote-assets] unsafe tar entry path: ${entryPath}`);
  }

  const normalized = posix.normalize(trimmed).replace(/\/+$/u, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`[remote-assets] unsafe tar entry path: ${entryPath}`);
  }
  return normalized;
}

function normalizeExtractSymlinkTarget({
  rawLinkTarget,
  targetPath,
  targetRoot,
}: {
  rawLinkTarget: string;
  targetPath: string;
  targetRoot: string;
}): string {
  const normalizedLinkTarget = normalizeSymlinkLinkName(rawLinkTarget);
  const resolvedTarget = resolve(dirname(targetPath), ...normalizedLinkTarget.split("/"));
  const relativePath = relative(targetRoot, resolvedTarget);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`[remote-assets] unsafe tar symlink target: ${rawLinkTarget}`);
  }
  return normalizedLinkTarget;
}

function normalizeSymlinkLinkName(rawLinkTarget: string): string {
  const normalized = posix.normalize(rawLinkTarget);
  // tar symlink 如果允许绝对路径、Windows drive 或反斜杠，解包后可能把本地缓存指向目标目录外。
  // 这里只保留 POSIX 相对 link target，并在解包时继续校验它解析后的落点。
  if (
    !rawLinkTarget ||
    !normalized ||
    normalized === "." ||
    normalized.includes("\\") ||
    isAbsolute(normalized) ||
    posix.isAbsolute(normalized) ||
    /^[a-zA-Z]:/u.test(normalized)
  ) {
    throw new Error(`[remote-assets] unsafe tar symlink target: ${rawLinkTarget}`);
  }
  return normalized;
}

function resolvePathWithinBase(baseDir: string, entryPath: string): string {
  const targetPath = resolve(baseDir, ...entryPath.split("/"));
  assertPathInsideBase(baseDir, targetPath, entryPath);
  return targetPath;
}

function assertPathInsideBase(baseDir: string, targetPath: string, sourceLabel: string): void {
  const relativePath = relative(baseDir, targetPath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`[remote-assets] unsafe tar entry path: ${sourceLabel}`);
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function applyMode(filePath: string, mode: number): Promise<void> {
  if (!mode) {
    return;
  }
  try {
    await chmod(filePath, mode & 0o777);
  } catch {
    // 权限位在 Windows 或受限文件系统上可能不可写，远端部署会按 executable 参数重新 chmod。
  }
}
