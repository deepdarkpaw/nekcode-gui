import { useMemo } from "react";
import { AlertCircle, Bot, CheckCircle2, CircleSlash, LoaderCircle, Square } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useNowTicker } from "@/hooks/useNowTicker.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatDuration, subagentElapsedMs } from "./format.js";
import { useNekStatusStore } from "./store.js";
import type { NekSessionStatus, NekStatusSubagent } from "./types.js";
import { useRunningSubagentsBarController } from "./useRunningSubagentsBarController.js";
import { useSubagentCardController, type SubagentCardView } from "./useSubagentCardController.js";

/**
 * 子代理状态分区：输入框上方**唯一**的子代理入口。
 *
 * 为什么不再是每个子代理一张大卡：开 5 个子代理时堆叠卡片会把对话区挤没。这里对齐
 * ZCodium 的 `SubagentStatusSection`：默认收起、收起态恒为一行（标题 + 最长耗时 +
 * 运行数 / 已结束计数），展开后在 `max-h-48` 的滚动列表里每行一个子代理。
 * 正文仍然只在右侧标准 tab 查看，状态区不重复最终回复。
 */
interface NekSubagentStatusSectionProps {
  sessionKey: string;
  onStop: (id: string) => Promise<void>;
  /** 点击行：在右侧标准 tab 打开该子代理完整对话。 */
  onOpenTranscript: (id: string) => void;
}

/**
 * 分区里的次要动作按钮：单行高度 + 紧凑内边距，图标 12px。
 *
 * 与 ZCodium 的「运行中停止」同款（ghost + 实心方块），不用 `destructive`：红底按钮在
 * 一行状态里比"停止"这个动作本身更响，且会让人以为已经出错。
 */
const COMPACT_GHOST_BUTTON_CLASS = "h-6 shrink-0 px-1.5 text-ui-base text-foreground";

/** 状态槽里的子代理身份（`NekStatusSubagent` 的附加字段只用于停止请求）。 */
function subagentRecords(status: NekSessionStatus | undefined): NekStatusSubagent[] {
  if (!status) return [];
  return status.subagents.order
    .map((id) => status.subagents.byId[id])
    .filter((record): record is NekStatusSubagent => record !== undefined);
}

export function NekSubagentStatusSection({
  sessionKey,
  onStop,
  onOpenTranscript,
}: NekSubagentStatusSectionProps) {
  const { intl } = useZCodeIntl();
  const status = useNekStatusStore((state) => state.sessions[sessionKey]);
  const records = useMemo(() => subagentRecords(status), [status]);
  const running = useMemo(() => records.filter((record) => record.status === "running"), [records]);
  const now = useNowTicker(running.length > 0);
  const longestElapsedMs = running.reduce(
    (longest, record) => Math.max(longest, subagentElapsedMs(record, now)),
    0,
  );
  // 「全部停止」沿用运行中条控制器的并发停止语义（逐个 onStop、失败计数可见），
  // 不在这里写第二份批量停止逻辑。
  const { actions: bulkActions } = useRunningSubagentsBarController({
    sessionKey,
    onStop,
    onFocusSubagent: onOpenTranscript,
  });
  if (records.length === 0) return null;
  const title = intl.formatMessage({ id: "settings.nek.project.resource.agents" });
  const stopAllLabel = intl.formatMessage({ id: "nek.status.subagent.stopAll" });
  const endedCount = records.length - running.length;
  return (
    <Fold
      defaultOpen={false}
      className="rounded-lg border border-card-border bg-card px-2 py-1"
      data-status-view="subagent-status-section"
      data-subagent-count={records.length}
    >
      <div className="flex min-w-0 items-center gap-2">
        <FoldTrigger chevron="start" className="min-w-0 flex-1">
          <Bot aria-hidden="true" className="size-3.5 shrink-0 text-foreground-subtle" />
          <span className="min-w-0 truncate font-medium text-ui-base text-foreground">{title}</span>
        </FoldTrigger>
        {running.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 text-ui-sm tabular-nums text-foreground-subtle">
            <span>{formatDuration(longestElapsedMs)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {running.length} {intl.formatMessage({ id: "nek.status.subagent.running" })}
            </span>
          </span>
        ) : (
          <span
            className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-ui-xs tabular-nums text-foreground-subtle"
            data-subagent-ended-count={endedCount}
          >
            {endedCount}
          </span>
        )}
        {running.length > 1 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={COMPACT_GHOST_BUTTON_CLASS}
            disabled={!bulkActions.stopAll.enabled}
            aria-busy={bulkActions.stopAll.pending || undefined}
            onClick={() => void bulkActions.stopAll.run()}
          >
            <Square aria-hidden="true" className="size-3 fill-current" />
            {stopAllLabel}
          </Button>
        ) : null}
      </div>
      {bulkActions.stopAll.error ? (
        <p role="alert" className="truncate text-ui-sm text-destructive">
          {bulkActions.stopAll.error}
        </p>
      ) : null}
      <FoldContent className="pt-1.5">
        <ul className="max-h-48 overflow-y-auto">
          {records.map((record) => (
            <NekSubagentStatusRow
              key={record.id}
              sessionKey={sessionKey}
              id={record.id}
              onStop={onStop}
              onOpenTranscript={onOpenTranscript}
            />
          ))}
        </ul>
      </FoldContent>
    </Fold>
  );
}

/** 状态图标只认语义 tone：文案 id 改名不会把图标换成另一个状态。 */
function subagentStatusIcon(tone: SubagentCardView["tone"]) {
  switch (tone) {
    case "success":
      return <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-success" />;
    case "danger":
      return <AlertCircle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />;
    case "muted":
      return (
        <CircleSlash aria-hidden="true" className="size-3.5 shrink-0 text-foreground-subtlest" />
      );
    default:
      // neutral：运行中与停止中都是"还有活在跑"，用同一个转圈图标。
      return (
        <LoaderCircle
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin text-foreground-subtle"
        />
      );
  }
}

/** 展开态的一行子代理：状态图标 + 描述/类型/耗时（点击开右侧 tab）+ 停止。 */
function NekSubagentStatusRow(props: {
  sessionKey: string;
  id: string;
  onStop: (id: string) => Promise<void>;
  onOpenTranscript: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { view, actions } = useSubagentCardController(props);
  if (!view.visible) return null;
  const error = actions.openTranscript.error ?? actions.stop.error;
  return (
    <li
      data-status-view="subagent-row"
      data-subagent-id={props.id}
      className="flex min-h-8 min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-ui-base hover:bg-hover"
    >
      {subagentStatusIcon(view.tone)}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused/30 disabled:opacity-50"
        disabled={!actions.openTranscript.enabled}
        aria-busy={actions.openTranscript.pending || undefined}
        aria-label={intl.formatMessage(
          { id: "nek.status.subagent.openPreview" },
          { description: view.title },
        )}
        onClick={() => void actions.openTranscript.run()}
      >
        <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">{view.title}</span>
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">{view.type}</span>
        <span className="shrink-0 font-mono text-ui-sm tabular-nums text-foreground-subtle">
          {view.elapsed}
        </span>
      </button>
      {error ? (
        <span role="alert" className="max-w-40 shrink-0 truncate text-ui-sm text-destructive">
          {error}
        </span>
      ) : null}
      {actions.stop.visible ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={COMPACT_GHOST_BUTTON_CLASS}
          disabled={!actions.stop.enabled}
          aria-busy={actions.stop.pending || undefined}
          aria-label={intl.formatMessage(
            { id: "nek.status.subagent.stopNamed" },
            { description: view.title },
          )}
          onClick={() => void actions.stop.run()}
        >
          <Square aria-hidden="true" className="size-3 fill-current" />
          {intl.formatMessage({ id: "nek.status.subagent.stop" })}
        </Button>
      ) : null}
    </li>
  );
}
