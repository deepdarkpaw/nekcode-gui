import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  BUNDLED_REMOTE_MANIFEST,
  BUNDLED_REMOTE_PLATFORM,
  parseBundledRemoteManifest,
  type BundledRemoteManifest,
} from "@zcode/shared/bundled-remote-assets";
import { extractTarGzBuffer } from "@zcode/server/remote/localTarGz.js";

type Component = BundledRemoteManifest["components"][number];
const MAX_ARCHIVE_BYTES = 128 * 1024 ** 2;
const MAX_MANIFEST_BYTES = 64 * 1024;

async function containedFile(directory: string, path: string): Promise<string> {
  const root = await realpath(directory);
  const file = await realpath(join(root, path));
  const rel = relative(root, file);
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    !(await stat(file)).isFile()
  ) {
    throw new Error(`Invalid bundled remote file: ${path}`);
  }
  return file;
}

/** One deployment owns the manifest snapshot and its temporary, verified extraction. */
export class BundledRemoteSource {
  private manifestPromise?: Promise<BundledRemoteManifest>;
  private snapshotPromise?: Promise<{
    manifest: BundledRemoteManifest;
    archiveSizes: ReadonlyMap<string, number>;
  }>;
  private directoryPromise: Promise<string> | undefined;
  private disposed = false;

  constructor(
    private readonly options: {
      directory: string;
      appVersion: string;
      platformArch: string;
      temporaryRoot?: string;
      signal?: AbortSignal;
    },
  ) {
    if (options.platformArch !== BUNDLED_REMOTE_PLATFORM) {
      throw new Error(`Unsupported bundled remote platform: ${options.platformArch}`);
    }
    if (!options.directory)
      throw new Error("Bundled remote assets are missing; rebuild or reinstall nekcode");
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Bundled remote source disposed");
    this.options.signal?.throwIfAborted();
  }

  async getManifest(): Promise<BundledRemoteManifest> {
    this.assertActive();
    return (this.manifestPromise ??= this.readManifest());
  }

  async getSnapshot() {
    this.assertActive();
    return (this.snapshotPromise ??= this.verifyArchives());
  }

  private async verifyArchive(component: Component, chunks?: Buffer[]): Promise<number> {
    this.assertActive();
    const path = await containedFile(this.options.directory, component.artifactPath);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(path, { signal: this.options.signal })) {
      size += chunk.length;
      if (size > MAX_ARCHIVE_BYTES)
        throw new Error(`Bundled remote archive too large: ${component.id}`);
      hash.update(chunk);
      chunks?.push(chunk);
    }
    if (size === 0 || hash.digest("hex") !== component.sha256) {
      throw new Error(`Bundled remote SHA256 mismatch: ${component.id}`);
    }
    return size;
  }

  private async readManifest() {
    const path = await containedFile(this.options.directory, BUNDLED_REMOTE_MANIFEST);
    // 多读一个字节以识别截断，不把过大的文件前缀当成完整 JSON。
    let contents = "";
    const stream = createReadStream(path, {
      end: MAX_MANIFEST_BYTES,
      encoding: "utf8",
      signal: this.options.signal,
    });
    for await (const chunk of stream) contents += chunk;
    if (Buffer.byteLength(contents, "utf8") > MAX_MANIFEST_BYTES)
      throw new Error("Bundled remote manifest too large");
    return parseBundledRemoteManifest(JSON.parse(contents), this.options.appVersion);
  }

  private async verifyArchives() {
    const manifest = await this.getManifest();
    const archiveSizes = new Map<string, number>();
    for (const component of manifest.components) {
      archiveSizes.set(component.id, await this.verifyArchive(component));
    }
    this.assertActive();
    return { manifest, archiveSizes };
  }

  resolveReleaseDir(): Promise<string> {
    try {
      this.assertActive();
      this.directoryPromise ??= this.materialize();
      return this.directoryPromise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async materialize(): Promise<string> {
    const manifest = await this.getManifest();
    this.assertActive();
    const directory = await mkdtemp(
      join(this.options.temporaryRoot ?? tmpdir(), "zcodium-remote-"),
    );
    try {
      for (const component of manifest.components) {
        // 校验与解包使用同一份字节，避免 manifest 固定后文件变化绕过校验。
        const chunks: Buffer[] = [];
        const size = await this.verifyArchive(component, chunks);
        const destination = join(directory, component.mount);
        await mkdir(destination, { recursive: true });
        await extractTarGzBuffer(Buffer.concat(chunks, size), destination);
        for (const requiredPath of component.requiredPaths) {
          await containedFile(destination, requiredPath);
        }
        this.assertActive();
      }
      this.assertActive();
      return directory;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const directory = await this.directoryPromise?.catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
