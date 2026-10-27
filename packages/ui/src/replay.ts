// 回放导出桶，只重导出回放页面仍使用的共享组件。
// 纪律：只 re-export，不定义任何东西。
export { SessionPane, type SessionPaneProps } from "./v4/SessionPane.js";
export {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "./v4/V4ConversationContext.js";
export { SessionDataLayer, type SessionLease } from "./v4/sessionDataLayer.js";
export type { ConversationTransport, ConversationAttachmentReadParams } from "./v4/transport.js";
export { TooltipProvider } from "./components/ui/tooltip.js";
export { ServiceProvider } from "./hooks/useServices.js";
export { PlatformProvider } from "./hooks/usePlatform.js";
export { StoreProvider, useZCodeStore } from "./store/StoreProvider.js";
export { TabStoreProvider } from "./store/TabStoreProvider.js";
export { DiffsWorkerPoolProvider } from "./root/DiffsWorkerPoolProvider.js";
export { ZCodeIntlProvider, useZCodeIntl } from "./i18n/IntlProvider.js";
export { Button } from "./components/ui/button.js";
export { cn } from "./components/lib/utils.js";
