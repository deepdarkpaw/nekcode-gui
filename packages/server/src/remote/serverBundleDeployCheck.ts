import { REMOTE_NODE_PATH, REMOTE_SERVER_PATH } from "./remoteAssetDeployDecision.js";
import { quotePosixPathArg, quotePosixShellArg } from "./posixShell.js";

// Check the live RPC wire format, not features removed from the shipped gui-server.
const REQUIRED_SERVER_BUNDLE_MARKERS = ["__zcode_rpc_nested_uint8array_v1"];

/** 在同一远端探测脚本中验证启动版本和能力标记，不在 JS host 读取远端 bundle。 */
export function buildServerBundleDeployCheck(appVersion: string): string {
  const node = quotePosixPathArg(REMOTE_NODE_PATH);
  const server = quotePosixPathArg(REMOTE_SERVER_PATH);
  const script = `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [path, version] = process.argv.slice(1);
const result = spawnSync(process.execPath, [path, "--version"], {
  encoding: "utf8", maxBuffer: 256, timeout: 5000, killSignal: "SIGKILL",
});
if (result.status !== 0 || result.stdout.trim() !== version) process.exit(1);
const markers = ${JSON.stringify(REQUIRED_SERVER_BUNDLE_MARKERS)};
(async () => {
  let tail = "";
  const missing = new Set(markers);
  for await (const chunk of fs.createReadStream(path, { encoding: "utf8" })) {
    const content = tail + chunk;
    for (const marker of missing) if (content.includes(marker)) missing.delete(marker);
    if (!missing.size) return;
    tail = content.slice(-64);
  }
  process.exitCode = 2;
})().catch(() => { process.exitCode = 2; });
`;
  return [
    `if [ -f ${node} ] && [ -f ${server} ]; then`,
    "  code=0",
    `  ${node} -e ${quotePosixShellArg(script)} ${server} ${quotePosixShellArg(appVersion)} >/dev/null 2>&1 || code=$?`,
    "  printf 'server-check\\t%s\\n' \"$code\"",
    "fi",
  ].join("\n");
}
