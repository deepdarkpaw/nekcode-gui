/**
 * 用户可见的统一格式：日期 `YYYY-MM-DD HH:mm`、24 小时内相对时间、大小 KB/MB/GB、tokens 用 k。
 *
 * 纯函数，不依赖 DOM / React；文案通过调用方传入的 formatMessage 取 i18n。
 */

type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 相对时间展示结果：label 为界面文字，title 为悬停 tooltip 文本（绝对时间）。 */
export interface RelativeTimeDisplay {
  label: string;
  title: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toDate(value: Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** 本地时区日期 `YYYY-MM-DD`。 */
export function formatDate(value: Date | number): string {
  const date = toDate(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 本地时区日期时间 `YYYY-MM-DD HH:mm`（24 小时制）。非法时间返回空串。 */
export function formatDateTime(value: Date | number): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${formatDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * 24 小时以内显示相对时间（刚刚 / n 分钟前 / n 小时前），否则显示绝对时间；
 * title 恒为绝对时间，供 tooltip / `title` 属性使用。未来时间（时钟偏差）直接显示绝对时间。
 */
export function formatRelativeTime(
  value: Date | number,
  formatMessage: FormatMessage,
  now: Date | number = Date.now(),
): RelativeTimeDisplay {
  const absolute = formatDateTime(value);
  const elapsed = toDate(now).getTime() - toDate(value).getTime();
  if (!absolute || elapsed < 0 || elapsed >= DAY_MS) {
    return { label: absolute, title: absolute };
  }
  if (elapsed < MINUTE_MS) {
    return { label: formatMessage({ id: "ui.relativeTime.justNow" }), title: absolute };
  }
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return {
      label: formatMessage({ id: "ui.relativeTime.minutesAgo" }, { count: minutes }),
      title: absolute,
    };
  }
  const hours = Math.floor(elapsed / HOUR_MS);
  return {
    label: formatMessage({ id: "ui.relativeTime.hoursAgo" }, { count: hours }),
    title: absolute,
  };
}

/** 最多保留一位小数并去掉多余的 `.0`。 */
function trimOneDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

const BYTE_UNITS = ["KB", "MB", "GB"] as const;

/**
 * 文件大小：二进制进位（1 KB = 1024 B），单位 B / KB / MB / GB，最多一位小数。
 * 四舍五入后达到 1024 的数值进位到下一单位（避免 `1024 KB`）。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (Math.round(bytes) < 1024) {
    return `${Math.round(bytes)} B`;
  }
  let value = bytes / 1024;
  let unitIndex = 0;
  while (unitIndex < BYTE_UNITS.length - 1 && Number(trimOneDecimal(value)) >= 1024) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${trimOneDecimal(value)} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * tokens：十进制 k（1k = 1000），如 `950`、`1k`、`12.3k`；≥ 1M 显示 `1.2M`。
 * 四舍五入后达到 1000k 的数值进位为 M（避免 `1000k`）。
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) {
    return "";
  }
  const sign = tokens < 0 ? "-" : "";
  const abs = Math.abs(tokens);
  if (Math.round(abs) < 1000) {
    return `${sign}${Math.round(abs)}`;
  }
  const thousands = trimOneDecimal(abs / 1000);
  if (Number(thousands) < 1000) {
    return `${sign}${thousands}k`;
  }
  return `${sign}${trimOneDecimal(abs / 1_000_000)}M`;
}

/** 时长：秒以下归零，分钟显示秒，小时以上显示补零的分钟。 */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Number.isFinite(milliseconds)
    ? Math.max(0, Math.floor(milliseconds / 1000))
    : 0;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 1) {
    return `${seconds}s`;
  }
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 1) {
    return `${minutes}m ${seconds}s`;
  }
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** 费用按美元显示：零为 `$0`，不足一美分显示 `<$0.01`。 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "$0";
  }
  if (usd < 0.01) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
}
