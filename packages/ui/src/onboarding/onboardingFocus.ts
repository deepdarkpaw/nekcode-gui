export interface ActiveElementInfo {
  editable: boolean;
  hasContent: boolean;
  hasSelection: boolean;
}

/** 新卡片出现时，输入框有内容或选区就不抢焦点。 */
export function shouldTakeFocus(active: ActiveElementInfo | null): boolean {
  return !(active?.editable && (active.hasContent || active.hasSelection));
}
