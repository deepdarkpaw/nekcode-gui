/**
 * 输入辅助（交互规范 §7.3）：
 * - 焦点不在可编辑元素时，直接打字会聚焦输入框并插入该字符；
 * - 自动聚焦时光标放在末尾。
 *
 * 判定拆成纯函数（事件 + 焦点上下文），DOM 读取只是薄包装，便于单测。
 */
import { isImeComposing, type ImeKeyEventLike } from "./imeComposition.js";

/** type-to-focus 判定所需的键盘事件子集。 */
export interface TypeToFocusKeyEvent extends ImeKeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
}

/** 当前焦点所处的上下文。 */
export interface TypeToFocusContext {
  /** 焦点在 body（或无焦点）。 */
  idle: boolean;
  /** 焦点在 input / textarea / select / contenteditable 内。 */
  editable: boolean;
  /** 焦点在自带键盘语义的组件内（菜单、列表、树、对话框等）或显式关闭的区域内。 */
  ownsKeys: boolean;
}

/** 自带打字/字符键语义的容器：在这些容器内不劫持按键。 */
const KEY_OWNER_SELECTOR = [
  "[role=menu]",
  "[role=menubar]",
  "[role=listbox]",
  "[role=tree]",
  "[role=treegrid]",
  "[role=grid]",
  "[role=combobox]",
  "[role=radiogroup]",
  "[role=tablist]",
  "[role=slider]",
  "[role=spinbutton]",
  "[role=dialog]",
  "[role=alertdialog]",
  "[data-type-to-focus=off]",
].join(",");

/** 不接收文字输入的 input 类型：焦点在这些控件上时允许 type-to-focus。 */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** 是否为会输出单个可打印字符的按键（无 Ctrl/Meta/Alt、非组字、未被其他处理器消费）。 */
export function isPrintableKeyEvent(event: TypeToFocusKeyEvent): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  if (isImeComposing(event)) {
    return false;
  }
  return [...event.key].length === 1;
}

/**
 * 是否应把按键转交给输入框。空格只在焦点空闲时转交——焦点在按钮等控件上时
 * 空格是激活键，不能被劫持。
 */
export function shouldTypeToFocus(
  event: TypeToFocusKeyEvent,
  context: TypeToFocusContext,
): boolean {
  if (!isPrintableKeyEvent(event) || context.editable || context.ownsKeys) {
    return false;
  }
  return event.key !== " " || context.idle;
}

/** 元素是否可编辑（input/textarea/select/contenteditable）。 */
export function isEditableElement(element: Element | null): boolean {
  if (typeof HTMLElement === "undefined" || !(element instanceof HTMLElement)) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  if (element instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(element.type);
  }
  return element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
}

/** 从当前焦点元素读取上下文。 */
export function readTypeToFocusContext(active: Element | null): TypeToFocusContext {
  const idle = active === null || active === active.ownerDocument.body;
  return {
    idle,
    editable: isEditableElement(active),
    ownsKeys: !idle && active?.closest(KEY_OWNER_SELECTOR) != null,
  };
}

/** 目标是否能接收输入（存在于文档、未禁用、非只读）。 */
export function canReceiveTypedText(target: HTMLElement): boolean {
  if (!target.isConnected) {
    return false;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return !target.disabled && !target.readOnly;
  }
  return target.isContentEditable;
}

/** 聚焦并把光标放到末尾（input / textarea / contenteditable 通用）。 */
export function focusAtEnd(target: HTMLElement): void {
  target.focus({ preventScroll: true });
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const end = target.value.length;
    target.setSelectionRange(end, end);
    return;
  }
  const selection = target.ownerDocument.getSelection();
  if (!selection) {
    return;
  }
  const range = target.ownerDocument.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
