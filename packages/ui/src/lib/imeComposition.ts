export function isImeComposingKeyEvent(event: {
  compositionActive?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  return Boolean(event.compositionActive || event.isComposing || event.nativeEvent?.isComposing);
}

/** IME 组字判定所需的键盘事件子集（React 合成事件与原生 KeyboardEvent 都满足）。 */
export interface ImeKeyEventLike {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

/** Chromium / Safari 在 IME 组字期间报告的 keyCode。 */
const IME_PROCESS_KEY_CODE = 229;

/**
 * 输入法组字中（中文/日文等候选未上屏）：`isComposing` 或 keyCode 229。
 * Enter 发送、Esc 关闭等键盘动作在组字期间必须放行给输入法。
 */
export function isImeComposing(event: ImeKeyEventLike): boolean {
  return (
    event.isComposing === true ||
    event.nativeEvent?.isComposing === true ||
    event.keyCode === IME_PROCESS_KEY_CODE ||
    event.nativeEvent?.keyCode === IME_PROCESS_KEY_CODE
  );
}
