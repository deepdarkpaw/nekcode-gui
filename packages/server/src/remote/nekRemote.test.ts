import { PassThrough } from "node:stream";
import { Emitter } from "@zcode/rpc";
import { describe, expect, it } from "vitest";
import type { IRemoteBackend, StdioStream } from "./backend.js";
import {
  buildNekInstallCommand,
  buildNekInstallPowerShellCommand,
  detectRemoteNek,
  installRemoteNek,
} from "./nekRemote.js";

function fakeBackend(payload: {
  code: number;
  stdout?: string;
  stderr?: string;
  onExec?: (stream: StdioStream) => void;
  closeDelayMs?: number;
}) {
  return {
    exec: async () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const close = new Emitter<number>();
      const stream: StdioStream = {
        stdin: new PassThrough(),
        stdout,
        stderr,
        signal: () => undefined,
        onClose: close.event,
      };
      queueMicrotask(() => {
        if (payload.stdout) stdout.end(payload.stdout);
        else stdout.end();
        if (payload.stderr) stderr.end(payload.stderr);
        else stderr.end();
        payload.onExec?.(stream);
        setTimeout(() => close.fire(payload.code), payload.closeDelayMs ?? 0);
      });
      return stream;
    },
  } as unknown as IRemoteBackend;
}

const readyInfo = JSON.stringify({
  protocolVersion: 1,
  nekVersion: "0.4.3",
  piVersion: "1.0.0",
  node: { path: "/usr/bin/node", version: "v24.0.0" },
  launch: { args: ["/opt/nek/cli.js"] },
  agentDir: "/home/test/.nek/agent",
  sessionDir: "/home/test/.nek/sessions",
  platform: "linux",
  arch: "x64",
});

describe("detectRemoteNek", () => {
  it("preserves the remote process attachment capability instead of using the local CLI's abilities", async () => {
    const info = { ...JSON.parse(readyInfo), capabilities: { promptAttachments: 1 } };
    const result = await detectRemoteNek(fakeBackend({ code: 0, stdout: JSON.stringify(info) }));
    expect(result.status).toBe("ready");
    expect(result.info?.capabilities?.promptAttachments).toBe(1);
    const older = await detectRemoteNek(fakeBackend({ code: 0, stdout: readyInfo }));
    expect(older.info?.capabilities?.promptAttachments).toBeUndefined();
  });

  it.each([
    ["ready", 0, readyInfo, ""],
    ["not_installed", 127, "", "sh: nek: command not found"],
    ["incompatible", 0, readyInfo.replace('"nekVersion":"0.4.3"', '"nekVersion":"0.4.2"'), ""],
    ["incompatible", 0, readyInfo.replace('"protocolVersion":1', '"protocolVersion":9'), ""],
    ["failed", 1, "", "permission denied"],
  ] as const)("returns %s", async (status, code, stdout, stderr) => {
    const result = await detectRemoteNek(fakeBackend({ code, stdout, stderr }));
    expect(result.status).toBe(status);
    expect(result.stderrSummary).toBe(stderr);
  });
});

describe("installRemoteNek", () => {
  it("streams each output line and exposes a manual command on failure", async () => {
    const lines: string[] = [];
    const result = await installRemoteNek(
      fakeBackend({ code: 1, stdout: "download\n", stderr: "failed\n" }),
      {
        repoUrl: "https://mirror.example/nek.git",
        channel: "dev",
        onLog: (line) => lines.push(line),
      },
    );
    expect(lines).toEqual(["download", "failed"]);
    expect(result.ok).toBe(false);
    expect(result.manualCommand).toContain("NEK_CHANNEL='dev'");
    expect(result.manualCommand).toContain("scripts/install.sh");
  });

  it("sends INT and closes the channel on cancellation", async () => {
    let signal = "";
    let streamRef: StdioStream | undefined;
    const backend = fakeBackend({
      code: 130,
      closeDelayMs: 10,
      onExec: (stream) => {
        streamRef = stream;
        stream.signal = (value) => {
          signal = value;
        };
      },
    });
    const controller = new AbortController();
    const installing = installRemoteNek(backend, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    const result = await installing;
    expect(result.cancelled).toBe(true);
    expect(signal).toBe("INT");
    expect(streamRef).toBeDefined();
  });
});

describe("install commands", () => {
  it("builds the official Windows PowerShell installer with the same options as install.sh", () => {
    const options = { channel: "dev" as const, nodeMirror: "https://mirror.example/node's" };
    const powershell = buildNekInstallPowerShellCommand(options);
    expect(powershell).toBe(
      "$env:NEK_CHANNEL='dev'; $env:NEK_REPO_URL='https://github.com/deepdarkpaw/nekcode.git'; " +
        "$env:NEK_NODE_MIRROR='https://mirror.example/node''s'; " +
        "irm 'https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.ps1' | iex",
    );
    expect(buildNekInstallCommand(options)).toContain("/scripts/install.sh");
    expect(buildNekInstallCommand(options)).toContain("NEK_CHANNEL=");
  });
});
