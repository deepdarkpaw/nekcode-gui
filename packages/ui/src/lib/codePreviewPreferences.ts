import type { BundledTheme } from "shiki";

const DARK_CODE_PREVIEW_THEMES: readonly BundledTheme[] = [
  "github-dark",
  "vitesse-dark",
  "min-dark",
  "github-dark-high-contrast",
  "catppuccin-mocha",
];

export function isDarkCodePreviewTheme(theme: BundledTheme): boolean {
  // 代码主题的明暗语义必须跟随设置页支持的显式选项，不能用主题名正则猜测。
  return DARK_CODE_PREVIEW_THEMES.includes(theme);
}
