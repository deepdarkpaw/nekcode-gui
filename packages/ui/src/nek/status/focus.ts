export interface ActiveElementInfo {
  editable: boolean;
  hasContent: boolean;
  hasSelection: boolean;
}

/** 输入框有内容或选区时，状态提示不抢焦点。 */
export function shouldTakeFocus(active: ActiveElementInfo): boolean {
  return !(active.editable && (active.hasContent || active.hasSelection));
}

export type StatusFocusId = "primary" | "back" | "composer" | string;

export interface StatusFocusController {
  target: StatusFocusId | null;
  ref: (id: StatusFocusId) => (element: HTMLElement | null) => void;
  request: (id: StatusFocusId) => void;
}

/** 无 DOM 时仍保持注册表语义；存在 DOM 时仅在下一帧聚焦已注册元素。 */
export function createStatusFocusController(
  schedule: (callback: FrameRequestCallback) => number = (callback) =>
    requestAnimationFrame(callback),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
): StatusFocusController {
  const elements = new Map<StatusFocusId, HTMLElement>();
  let target: StatusFocusId | null = null;
  let frame: number | null = null;
  const focus: StatusFocusController = {
    get target() {
      return target;
    },
    ref: (id) => (element) => {
      if (element) elements.set(id, element);
      else elements.delete(id);
    },
    request: (id) => {
      target = id;
      if (frame !== null) cancel(frame);
      frame = schedule(() => {
        frame = null;
        const element = elements.get(id);
        if (element && !element.hasAttribute("disabled")) {
          element.focus({ preventScroll: true });
        }
      });
    },
  };
  return focus;
}
