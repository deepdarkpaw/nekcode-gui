import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { NekGuiInfo } from "@zcode/shared/nek-protocol";
import { createNekAgentServiceAdapter } from "../src/nek-agent/adapter/index.js";

const worktree = process.env.NEK_RPC_WORKTREE;
const enabled = process.env.NEK_E2E === "1" && Boolean(worktree);

/** A real text PDF, generated in memory; no native PDF tool or provider request is needed. */
function pdfBytes(): Buffer {
  const text = "BT /F1 12 Tf 72 720 Td (PDF_ATTACHMENT_SENTINEL) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let output = "%PDF-1.4\n";
  const positions = [0];
  for (const [index, value] of objects.entries()) {
    positions.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${value}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${positions.length}\n0000000000 65535 f \n`;
  for (const position of positions.slice(1))
    output += `${String(position).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(
    `${output}trailer\n<< /Size ${positions.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((block) => block?.text ?? "").join("\n") : "";
}

async function waitFor(check: () => boolean, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("attachment E2E did not settle");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test(
  "real nek: mixed attachments survive temporary-source deletion, tool reads, and application restart",
  {
    skip: enabled ? false : "set NEK_E2E=1 and NEK_RPC_WORKTREE for local mock E2E",
    timeout: 120_000,
  },
  async () => {
    assert.ok(worktree);
    const tmp = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
    await mkdir(tmp, { recursive: true });
    const root = await mkdtemp(join(tmp, "nek-attachment-e2e-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    const staging = join(root, "target-staging");
    await mkdir(agentDir);
    await mkdir(project);
    const logPath = join(project, "large.log");
    const logText =
      `${"unrelated log data ".repeat(4)}\n`.repeat(18_000) + "LARGE_ATTACHMENT_LAST_LINE";
    await writeFile(logPath, logText);
    const pdf = pdfBytes();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      "base64",
    );
    let release!: () => void;
    const sourcesRemoved = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    let mockError: unknown;
    let finalResult = false;
    const stablePaths: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        void (async () => {
          const payload = JSON.parse(body);
          requests++;
          const messages = payload.messages as Array<{ role: string; content: unknown }>;
          const allText = messages.map((message) => contentText(message.content)).join("\n");
          response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
          const send = (delta: unknown, finish_reason: string | null = null) =>
            response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
          if (requests === 1) {
            assert.ok(
              !allText.includes("LARGE_ATTACHMENT_LAST_LINE"),
              "large files must not be pre-expanded into messages",
            );
            const files = allText.split("\n").flatMap((line) => {
              if (!line.startsWith('{"path":')) return [];
              return [JSON.parse(line) as { path: string; fileName: string }];
            });
            const log = files.find((file) => file.fileName === "large.log");
            const document = files.find((file) => file.fileName === "report.pdf");
            assert.ok(log && document, "model receives stable file descriptions");
            stablePaths.push(...files.map((file) => file.path));
            assert.ok(stablePaths.every((path) => path.startsWith(join(agentDir, "attachments"))));
            assert.ok(
              messages.some(
                (message) =>
                  Array.isArray(message.content) &&
                  message.content.some((block) => block?.type === "image_url"),
              ),
              "image enters the visual model request",
            );
            await sourcesRemoved;
            send({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "read_log",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ path: log.path, offset: 18001, limit: 1 }),
                  },
                },
                {
                  index: 1,
                  id: "read_pdf",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ path: document.path, pages: "1" }),
                  },
                },
              ],
            });
            send({}, "tool_calls");
          } else {
            assert.ok(
              allText.includes("LARGE_ATTACHMENT_LAST_LINE"),
              "read tool returns the requested final line",
            );
            assert.ok(
              allText.includes("PDF_ATTACHMENT_SENTINEL"),
              "PDF read extracts actual page text",
            );
            finalResult = true;
            send({ role: "assistant", content: "Attachments read successfully." });
            send({}, "stop");
          }
          response.end("data: [DONE]\n\n");
        })().catch((error) => {
          mockError = error;
          response.destroy(error as Error);
        });
      });
    });
    let adapter: ReturnType<typeof createNekAgentServiceAdapter> | undefined;
    const oldAgentDir = process.env.NEK_CODING_AGENT_DIR;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            mock: {
              api: "openai-completions",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "test-key",
              models: [
                {
                  id: "mock-model",
                  name: "Local mock",
                  reasoning: false,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 4096,
                },
              ],
            },
          },
        }),
      );
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultProvider: "mock",
          defaultModel: "mock-model",
          defaultProjectTrust: "always",
        }),
      );
      process.env.NEK_CODING_AGENT_DIR = agentDir;
      const guiInfo: NekGuiInfo = {
        protocolVersion: 1,
        capabilities: { promptAttachments: 1 },
        nekVersion: "source",
        piVersion: "source",
        node: { path: process.execPath, version: process.version },
        launch: {
          args:
            process.env.NEK_RPC_USE_BUNDLE === "1"
              ? [join(worktree, "packages/coding-agent/dist/bundle/cli.js")]
              : [
                  "--import",
                  pathToFileURL(
                    join(worktree, "packages/coding-agent/src/experimental/source-resolver.ts"),
                  ).href,
                  join(worktree, "packages/coding-agent/src/cli.ts"),
                ],
        },
        agentDir,
        sessionDir: join(agentDir, "sessions"),
        platform: process.platform,
        arch: process.arch,
      };
      const options = {
        guiInfo,
        cwd: project,
        attachmentStagingDir: staging,
        askProjectTrust: () => true,
      };
      adapter = createNekAgentServiceAdapter(options);
      const created = await adapter.createNekSession({ workspacePath: project });
      const target = { workspacePath: project, sessionId: created.sessionId };
      const refs = [];
      for (const [fileName, mime, bytes] of [
        ["report.pdf", "application/pdf", pdf],
        ["pasted.png", "image/png", png],
      ] as const) {
        const upload = {
          ...target,
          uploadId: fileName,
          fileName,
          mime,
          totalBytes: bytes.length,
          totalChunks: 1,
          checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        };
        await adapter.attachmentBeginV4(upload);
        await adapter.attachmentChunkV4({
          ...target,
          uploadId: fileName,
          chunkIndex: 0,
          dataBase64: bytes.toString("base64"),
        });
        const { ref } = await adapter.attachmentCommitV4({ ...target, uploadId: fileName });
        refs.push({ ref, fileName, mime, bytes: bytes.length });
      }
      await adapter.sendNekConversationCommandV4({
        target: { workspacePath: project },
        envelope: {
          commandId: "mixed-files",
          clientId: "test",
          sessionId: created.sessionId,
          type: "sendText",
          issuedAt: 1,
          payload: {
            text: "Inspect these attachments.",
            attachments: [
              ...refs,
              {
                ref: logPath,
                fileName: "large.log",
                mime: "text/plain",
                bytes: Buffer.byteLength(logText),
              },
            ],
          },
        },
      });
      await adapter.sendNekConversationCommandV4({
        target: { workspacePath: project },
        envelope: {
          commandId: "queued-files",
          clientId: "test",
          sessionId: created.sessionId,
          type: "sendText",
          issuedAt: 2,
          payload: { text: "queued document", requestedDelivery: "queue", attachments: [refs[0]!] },
        },
      });
      const taken = await adapter.clearNekQueue(target);
      assert.deepEqual(taken.followUp, ["queued document"]);
      const queuedFile = taken.inputs?.followUp[0]?.attachments?.[0];
      assert.equal(queuedFile?.fileName, "report.pdf");
      assert.ok(queuedFile?.path.startsWith(join(agentDir, "attachments")));
      await rm(logPath);
      await rm(staging, { recursive: true, force: true });
      // Retrieving/editing a queued input must not turn persistent remote files back into host upload sources.
      await adapter.requeueNekQueue({ ...target, queue: taken });
      const retaken = await adapter.clearNekQueue(target);
      assert.deepEqual(retaken.inputs, taken.inputs);
      release();
      await waitFor(() => finalResult || mockError !== undefined);
      if (mockError) throw mockError;
      await waitFor(() => adapter!.service.getSession(created.sessionKey)?.phase === "idle");
      await adapter.dispose();
      adapter = createNekAgentServiceAdapter(options);
      const restored = await adapter.readNekSession(target);
      const user = restored.rows.window.find((row) => row.kind === "userInput");
      assert.ok(user?.kind === "userInput");
      assert.equal(user.text, "Inspect these attachments.");
      assert.equal(user.attachments?.length, 3);
      const pdfIndex = user.attachments.findIndex((file) => file.fileName === "report.pdf");
      assert.ok(pdfIndex >= 0);
      const result = await adapter.conversationAttachmentReadV4({
        ...target,
        ref: user.attachments[pdfIndex]!.ref,
        target: { rowId: user.rowId, entityId: user.entityId },
        attachmentIndex: pdfIndex,
        offset: 0,
        limit: pdf.length,
      });
      assert.deepEqual(Buffer.from(result.dataBase64, "base64"), pdf);
      for (const path of stablePaths) assert.ok((await readFile(path)).length > 0);
      assert.equal(requests, 2, "restart and preview do not call a model");
    } finally {
      release();
      await adapter?.dispose();
      process.env.NEK_CODING_AGENT_DIR = oldAgentDir;
      if (oldAgentDir === undefined) delete process.env.NEK_CODING_AGENT_DIR;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
