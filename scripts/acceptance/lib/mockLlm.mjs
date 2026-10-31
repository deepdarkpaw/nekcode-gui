/**
 * 本地 OpenAI 兼容 SSE 模拟服务：第一轮回一句话 + 一个 `ls` 工具调用，之后回结束语。
 * 只用于验收，不访问任何真实模型 API。
 */
import { createServer } from "node:http";

export const MOCK_FINAL_TEXT = "The workspace listing is complete.";

function chunk(delta, finishReason = null) {
  return { choices: [{ delta, finish_reason: finishReason }] };
}

function firstTurn() {
  return [
    chunk({ role: "assistant", content: "I will inspect the workspace.\n" }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_ls",
          type: "function",
          function: { name: "ls", arguments: '{"path":"."}' },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ];
}

function finalTurn() {
  return [chunk({ role: "assistant", content: MOCK_FINAL_TEXT }), chunk({}, "stop")];
}

/** 启动服务，返回 `{ baseUrl, requests, close }`。 */
export async function startMockLlm() {
  const requests = [];
  const server = createServer((request, response) => {
    const body = [];
    request.on("data", (part) => body.push(part));
    request.on("end", () => {
      requests.push({ url: request.url, bytes: Buffer.concat(body).length });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
        "cache-control": "no-cache",
      });
      const events = requests.length % 2 === 1 ? firstTurn() : finalTurn();
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** nek 的 models.json / settings.json：只有一个指向模拟服务的 provider。 */
export function mockNekConfig(baseUrl) {
  const models = {
    providers: {
      mock: {
        baseUrl,
        api: "openai-completions",
        apiKey: "acceptance-key",
        models: [
          {
            id: "mock-model",
            name: "Local Mock Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 4096,
          },
        ],
      },
    },
  };
  const settings = { defaultProvider: "mock", defaultModel: "mock-model" };
  return { models, settings };
}
