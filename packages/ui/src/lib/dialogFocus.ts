/**
 * 对话框焦点约定（交互规范 §7.3）：
 * - 表单类对话框打开时聚焦第一个空的必填项；
 * - 主按钮因表单无效被点击时聚焦第一个出错字段；
 * - 确认类对话框聚焦安全选项（标记 `data-dialog-safe-action`）；AlertDialog 的
 *   `AlertDialogCancel` 本身由 Radix 默认聚焦，无需额外处理。
 *
 * 选择逻辑是纯函数（字段状态数组），DOM 读取只是薄包装。
 */
import { logger } from "@/logger.js";

/** 字段状态快照：只包含选择决策需要的信息。 */
export interface FieldFocusState {
  empty: boolean;
  required: boolean;
  disabled: boolean;
  invalid: boolean;
}

/** 确认类对话框里安全选项的标记属性。 */
export const DIALOG_SAFE_ACTION_ATTRIBUTE = "data-dialog-safe-action";

const FIELD_SELECTOR = [
  "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset])",
  "textarea",
  "select",
  "[contenteditable=true]",
  "[role=combobox]",
].join(",");

/** 第一个可聚焦的空必填项下标；没有返回 -1。 */
export function pickFirstEmptyRequired(fields: readonly FieldFocusState[]): number {
  return fields.findIndex((field) => field.required && field.empty && !field.disabled);
}

/** 第一个可聚焦的出错字段下标；没有返回 -1。 */
export function pickFirstInvalid(fields: readonly FieldFocusState[]): number {
  return fields.findIndex((field) => field.invalid && !field.disabled);
}

function readFieldValue(element: HTMLElement): string {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    if (element instanceof HTMLInputElement && element.type === "checkbox") {
      return element.checked ? "on" : "";
    }
    return element.value;
  }
  // Radix Select trigger 在未选择时带 data-placeholder。
  if (element.getAttribute("role") === "combobox") {
    return element.hasAttribute("data-placeholder") ? "" : "selected";
  }
  return element.textContent ?? "";
}

/** 读取字段状态（DOM → 纯数据）。 */
export function readFieldFocusState(element: HTMLElement): FieldFocusState {
  const nativeRequired = "required" in element && (element as HTMLInputElement).required;
  const nativeDisabled = "disabled" in element && (element as HTMLInputElement).disabled;
  return {
    empty: readFieldValue(element).trim() === "",
    required: nativeRequired || element.getAttribute("aria-required") === "true",
    disabled: nativeDisabled || element.getAttribute("aria-disabled") === "true",
    invalid: element.getAttribute("aria-invalid") === "true",
  };
}

function listFields(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FIELD_SELECTOR));
}

function focusPicked(
  container: ParentNode,
  pick: (fields: readonly FieldFocusState[]) => number,
): boolean {
  const elements = listFields(container);
  const element = elements[pick(elements.map(readFieldFocusState))];
  if (!element) {
    return false;
  }
  element.focus();
  return true;
}

/** 聚焦容器内第一个空的必填项；成功返回 true。 */
export function focusFirstEmptyRequiredField(container: ParentNode): boolean {
  return focusPicked(container, pickFirstEmptyRequired);
}

/** 聚焦容器内第一个出错字段（`aria-invalid="true"`）；成功返回 true。 */
export function focusFirstInvalidField(container: ParentNode): boolean {
  return focusPicked(container, pickFirstInvalid);
}

function eventContainer(event: Event): HTMLElement | null {
  return event.target instanceof HTMLElement ? event.target : null;
}

/**
 * 表单对话框的 `onOpenAutoFocus`：有空必填项时聚焦它并阻止 Radix 默认聚焦；
 * 没有时交给 Radix 默认行为（聚焦第一个可聚焦元素）。
 */
export function handleFormDialogOpenAutoFocus(event: Event): void {
  const container = eventContainer(event);
  if (container && focusFirstEmptyRequiredField(container)) {
    event.preventDefault();
  }
}

/**
 * 确认对话框（基于 Dialog 而非 AlertDialog 时）的 `onOpenAutoFocus`：
 * 聚焦标记了 `data-dialog-safe-action` 的安全选项。缺少标记属于调用方缺陷，记录警告。
 */
export function handleConfirmDialogOpenAutoFocus(event: Event): void {
  const container = eventContainer(event);
  const safeAction = container?.querySelector<HTMLElement>(`[${DIALOG_SAFE_ACTION_ATTRIBUTE}]`);
  if (!safeAction) {
    logger.warn("[dialogFocus] confirm dialog has no safe action marked", {
      attribute: DIALOG_SAFE_ACTION_ATTRIBUTE,
    });
    return;
  }
  event.preventDefault();
  safeAction.focus();
}
