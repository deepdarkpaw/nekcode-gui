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
export const MOCK_SLOW_CHUNKS = 120;
export const MOCK_PLAN_TITLE = "Acceptance workspace plan";
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
    {
      ...chunk({}, "tool_calls"),
      usage: { prompt_tokens: 128, completion_tokens: 32, total_tokens: 160 },
    },
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

/** nek 的扩展提示会映射成 user 消息，但纯 reminder 不是用户新开的一轮。 */
function isReminderOnly(content) {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        : "";
  if (!text.trim()) return false;
  return (
    text
      .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gu, "")
      .replace(/<plan_mode_guardrails>[\s\S]*?<\/plan_mode_guardrails>/gu, "")
      .trim() === ""
  );
}

/** 只读取最新用户回合的工具结果；旧回合的 switch_mode 不能覆盖后续停止测试。 */
export function pickMockTurn(body) {
  const { messages } = JSON.parse(body);
  if (!Array.isArray(messages)) throw new Error("mock expects a messages array");
  const userIndex = messages.findLastIndex(
    (message) => message?.role === "user" && !isReminderOnly(message.content),
  );
  const currentTurn = messages.slice(userIndex + 1);
  const lastTool = currentTurn.findLast((message) => message?.role === "tool");
  const toolCallId = lastTool?.tool_call_id;
  if (toolCallId === "call_ls") return "ask";
  if (toolCallId === "call_ask") {
    const result = JSON.stringify(lastTool.content);
    if (!result.includes(MOCK_QUESTION_ANSWER_OPTION) || !result.includes(MOCK_OTHER_ANSWER)) {
      throw new Error("mock did not receive both expected question answers");
    }
    return "switch";
  }
  if (toolCallId === "call_switch") {
    if (!JSON.stringify(lastTool.content).includes("You are now in Plan mode")) {
      throw new Error("mock did not receive the approved mode switch");
    }
    return "plan";
  }
  const content = messages[userIndex]?.content;
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  if (text.includes("Implement the plan.") && text.includes(MOCK_PLAN_TITLE)) return "final";
  if (text.includes(MOCK_LONG_PROMPT)) return "slow";
  if (text.includes(MOCK_FIRST_PROMPT)) return "first";
  throw new Error(
    `mock received an unrecognized conversation turn (last tool: ${toolCallId ?? "none"}; user: ${text.slice(0, 300)})`,
  );
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
    let record;
    request.on("data", (part) => {
      bytes += part.length;
      if (bytes <= MAX_BODY_BYTES) body.push(part);
      else if (!response.writableEnded) {
        response.writeHead(413).end("mock request body limit exceeded");
      }
    });
    response.on("close", () => {
      if (record) record.aborted = !response.writableFinished;
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      if (requests.length >= MAX_REQUESTS) {
        response.writeHead(429).end("mock request limit exceeded");
        return;
      }
      let turn;
      try {
        turn = pickMockTurn(Buffer.concat(body).toString("utf8"));
      } catch (error) {
        requests.push({ url: request.url, turn: "invalid", error: error.message, aborted: false });
        response.writeHead(400).end(error.message);
        return;
      }
      record = { url: request.url, turn, aborted: false };
      requests.push(record);
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
        if (!response.writableEnded && !response.destroyed) response.end("data: [DONE]\n\n");
      };
      if (turn === "slow") {
        void (async () => {
          // 逐块慢速输出，验收脚本在流式过程中点停止。
          write(chunk({ role: "assistant", content: "Working through the long task" }));
          for (let index = 0; index < slowChunks; index += 1) {
            if (record.aborted) break;
            await new Promise((resolve) => setTimeout(resolve, slowDelayMs));
            if (record.aborted) break;
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
              : turn === "plan"
                ? toolTurn("call_plan", "create_plan", {
                    name: MOCK_PLAN_TITLE,
                    overview: "Confirm the workspace listing and the selected database.",
                    plan: `# ${MOCK_PLAN_TITLE}\n\nSummarize the workspace listing and the approved Redis choice.`,
                    todos: [{ id: "summarize", content: "Summarize the inspected workspace" }],
                  })
                : textTurn(MOCK_FINAL_TEXT);
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
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
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
