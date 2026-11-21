import type { ZCodeProtocolMcpServer } from "./zcode-protocol/index.js";

/** 旧会话传输形状，仅用于保留会话/归档契约；nek MCP 由 nek 配置 API 管理。 */
export type ZCodeAgentMcpServer = ZCodeProtocolMcpServer;
