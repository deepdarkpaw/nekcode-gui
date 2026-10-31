/**
 * 本地 OpenAI 兼容 SSE 模拟服务：按会话里最后一条 tool 结果决定下一轮，用于驱动真实链路验收。
 *
 * 剧本（与 packaged-e2e 的步骤一一对应）：
 * 1. 首轮：一句话 + `ls` 工具调用；
 * 2. `ls` 之后：`ask_question`（两问：单选 / 其他输入）；
 * 3. 回答之后：`switch_mode`（切到 plan）；
 * 4. 批准之后：最终回复；
 * 5. 用户发 “Run a long task.” 时慢速流式输出，供“运行中停止”验收。
 * 只用于验收，不访问任何真实模型 API。
 */
import { createServer } from "node:http";

export const MOCK_FINAL_TEXT = "The workspace listing is complete.";
export const MOCK_LONG_PROMPT = "Run a long task.";
export const MOCK_FIRST_PROMPT = "List the files in this workspace.";
export const MOCK_QUESTION_TEXT = "Which database should we use?";
export const MOCK_QUESTION_ANSWER_OPTION = "Redis";
export const MOCK_SECOND_QUESTION_TEXT = "Anything else to record?";
export const MOCK_OTHER_ANSWER = "Prefer in-memory caching";
export const MOCK_SLOW_CHUNKS = 40;
const MAX_REQUESTS = 200;
const MAX_BODY_BYTES = 256 * 1024;

function chunk(delta, finishReason = null) {
  return { choices: [{ delta, finish_reason: finishReason }] };
}

function usageChunk() {
  return {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 128, completion_tokens: 32, total_tokens: 160 },
  };
}

function textTurn(text) {
  return [chunk({ role: "assistant", content: text }), usageChunk()];
}

function toolTurn(callId, name, args, preamble) {
  return [
    chunk({ role: "assistant", content: preamble ?? "" }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: callId,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ];
}

const askQuestionArguments = {
  title: "Acceptance questions",
  questions: [
    {
      id: "q1",
      prompt: MOCK_QUESTION_TEXT,
      options: [
        { id: "opt-sqlite", label: "SQLite" },
        { id: "opt-redis", label: MOCK_QUESTION_ANSWER_OPTION },
      ],
    },
    {
      id: "q2",
      prompt: MOCK_SECOND_QUESTION_TEXT,
      options: [
        { id: "opt-none", label: "Nothing else" },
        { id: "opt-cache", label: "Caching notes" },
      ],
    },
  ],
};

const switchModeArguments = { explanation: "Plan the migration first.", target_mode_id: "plan" };

/** 只看最后一条 tool 结果决定剧本，历史里的旧 tool_call 不会串台。 */
export function pickMockTurn(body) {
  let messages = [];
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed?.messages)) messages = parsed.messages;
  } catch {
    return "fallback";
  }
  const lastTool = [...messages].reverse().find((message) => message?.role === "tool");
  const toolCallId = lastTool?.tool_call_id ?? lastTool?.toolCallId;
  if (toolCallId === "call_ls") return "ask";
  if (toolCallId === "call_ask") return "switch";
  if (toolCallId === "call_switch") return "final";
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const raw =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : JSON.stringify(lastUser?.content ?? "");
  if (raw.includes(MOCK_LONG_PROMPT)) return "slow";
  if (raw.includes(MOCK_FIRST_PROMPT)) return "first";
  return "fallback";
}

/**
 * 启动服务，返回 `{ baseUrl, requests, close }`。
 * `requests` 只保留有界摘要：分类、是否被客户端中止；不保存 prompt 原文。
 */
export async function startMockLlm(options = {}) {
  const slowChunks = options.slowChunks ?? MOCK_SLOW_CHUNKS;
  const slowDelayMs = options.slowDelayMs ?? 250;
  const requests = [];
  const server = createServer((request, response) => {
    const body = [];
    let bytes = 0;
    let aborted = false;
    request.on("data", (part) => {
      if (bytes < MAX_BODY_BYTES) {
        body.push(part);
        bytes += part.length;
      }
    });
    response.on("close", () => {
      aborted = true;
    });
    request.on("end", () => {
      const turn = pickMockTurn(Buffer.concat(body).toString("utf8"));
      if (requests.length < MAX_REQUESTS) requests.push({ url: request.url, turn, aborted: false });
      const record = requests.at(-1);
      const write = (event) => {
        if (response.writableEnded || response.destroyed) return false;
        response.write(`data: ${JSON.stringify(event)}\n\n`);
        return true;
      };
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
        "cache-control": "no-cache",
      });
      const finish = () => {
        if (record) record.aborted = aborted;
        if (!response.writableEnded) response.end("data: [DONE]\n\n");
      };
      if (turn === "slow") {
        void (async () => {
          // 逐块慢速输出，验收脚本在流式过程中点停止。
          write(chunk({ role: "assistant", content: "Working through the long task" }));
          for (let index = 0; index < slowChunks; index += 1) {
            if (aborted) break;
            await new Promise((resolve) => setTimeout(resolve, slowDelayMs));
            if (aborted) break;
            write(chunk({ content: ` step ${index + 1}.` }));
          }
          finish();
        })();
        return;
      }
      const events =
        turn === "first"
          ? toolTurn("call_ls", "ls", { path: "." }, "I will inspect the workspace.\n")
          : turn === "ask"
            ? toolTurn("call_ask", "ask_question", askQuestionArguments)
            : turn === "switch"
              ? toolTurn("call_switch", "switch_mode", switchModeArguments)
              : textTurn(turn === "final" ? MOCK_FINAL_TEXT : "acceptance");
      for (const event of events) write(event);
      finish();
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

/** nek 的 models.json / settings.json：两个模型都指向模拟服务。 */
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
          {
            id: "mock-model-2",
            name: "Local Mock Model 2",
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
