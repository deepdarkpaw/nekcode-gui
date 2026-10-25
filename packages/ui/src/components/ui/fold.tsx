/**
 * 统一折叠原语（交互规范 §7.4）：chevron 旋转 + 150 ms motion 高度动画。
 *
 * 用于 thinking 块、工具卡、长用户消息、长代码块、压缩/分支摘要、子代理卡、todo、计划卡、
 * 设置页「高级」分组、MCP 工具列表。受控（open + onOpenChange）或非受控（defaultOpen）。
 * 需要「全局切换 + 单项覆盖」或跨重渲染保持时，用 `useFoldState` 驱动受控模式：
 *
 * ```tsx
 * const [open, setOpen] = useFoldState(toolCallId, "toolOutput", isError);
 * <Fold open={open} onOpenChange={setOpen} focusable>
 *   <FoldTrigger>{title}</FoldTrigger>
 *   {open ? null : <ToolPreview />}
 *   <FoldContent>{output}</FoldContent>
 * </Fold>
 * ```
 */
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronRightIcon } from "lucide-react";
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { cn } from "../lib/utils.js";
import { isImeComposing } from "@/lib/imeComposition.js";

export { useFoldState, useFoldStore, type FoldGroup } from "@/lib/foldState.js";

/** 折叠动画时长（秒）。 */
export const FOLD_DURATION_SECONDS = 0.15;

interface FoldContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  contentId: string;
  disabled: boolean;
}

const FoldContext = createContext<FoldContextValue | null>(null);

/** 读取最近的 Fold 上下文。 */
export function useFold(): FoldContextValue {
  const context = useContext(FoldContext);
  if (!context) {
    throw new Error("Fold 子组件必须放在 <Fold> 内使用");
  }
  return context;
}

export type FoldKeyAction = "toggle" | "open" | "close" | null;

/**
 * 焦点在卡片本身时的按键动作：Space / Enter 切换；开启 arrowKeys 时 ← 折叠、→ 展开。
 * 组字中的按键与带修饰键的组合不处理。
 */
export function resolveFoldKeyAction(
  event: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    isComposing?: boolean;
    keyCode?: number;
  },
  arrowKeys: boolean,
): FoldKeyAction {
  if (event.ctrlKey || event.metaKey || event.altKey || isImeComposing(event)) {
    return null;
  }
  if (event.key === " " || event.key === "Enter") {
    return "toggle";
  }
  if (arrowKeys && event.key === "ArrowLeft") {
    return "close";
  }
  if (arrowKeys && event.key === "ArrowRight") {
    return "open";
  }
  return null;
}

export interface FoldProps extends Omit<ComponentProps<"div">, "onChange"> {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** 卡片本身可聚焦：Space / Enter 切换。 */
  focusable?: boolean;
  /** 树视图：← 折叠、→ 展开（需 focusable）。 */
  arrowKeys?: boolean;
}

export function Fold({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  focusable = false,
  arrowKeys = false,
  className,
  onKeyDown,
  children,
  ...props
}: FoldProps) {
  const [open, setOpenState] = useControllableState<boolean>({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
    caller: "Fold",
  });
  const contentId = useId();
  const setOpen = useCallback(
    (next: boolean) => {
      if (!disabled) {
        setOpenState(next);
      }
    },
    [disabled, setOpenState],
  );
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const context = useMemo(
    () => ({ open, setOpen, toggle, contentId, disabled }),
    [open, setOpen, toggle, contentId, disabled],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    // 只处理卡片本身的按键；内部按钮、输入框、选区操作不受影响。
    if (!focusable || event.defaultPrevented || event.target !== event.currentTarget) {
      return;
    }
    const action = resolveFoldKeyAction(event.nativeEvent, arrowKeys);
    if (action === null) {
      return;
    }
    event.preventDefault();
    setOpen(action === "toggle" ? !open : action === "open");
  };

  return (
    <FoldContext.Provider value={context}>
      <div
        data-slot="fold"
        data-state={open ? "open" : "closed"}
        tabIndex={focusable ? 0 : undefined}
        aria-expanded={focusable ? open : undefined}
        className={cn(
          focusable &&
            "outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused/30",
          className,
        )}
        onKeyDown={handleKeyDown}
        {...props}
      >
        {children}
      </div>
    </FoldContext.Provider>
  );
}

/** chevron：折叠时向右，展开时旋转 90° 向下。 */
export function FoldChevron({ className }: { className?: string }) {
  const { open } = useFold();
  return (
    <ChevronRightIcon
      aria-hidden="true"
      data-slot="fold-chevron"
      className={cn(
        "size-4 shrink-0 text-foreground-subtlest transition-transform duration-150 ease-out motion-reduce:transition-none",
        open && "rotate-90",
        className,
      )}
    />
  );
}

export interface FoldTriggerProps extends Omit<ComponentProps<"button">, "type"> {
  /** chevron 位置；false 表示调用方自行放置 `<FoldChevron />`。 */
  chevron?: "start" | "end" | false;
  children?: ReactNode;
}

export function FoldTrigger({
  chevron = "start",
  className,
  children,
  onClick,
  ...props
}: FoldTriggerProps) {
  const { open, toggle, contentId, disabled } = useFold();
  return (
    <button
      type="button"
      data-slot="fold-trigger"
      aria-expanded={open}
      aria-controls={contentId}
      disabled={disabled}
      className={cn(
        "group/fold-trigger inline-flex min-w-0 items-center gap-1.5 text-left text-ui-base outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused/30 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          toggle();
        }
      }}
      {...props}
    >
      {chevron === "start" ? <FoldChevron /> : null}
      {children}
      {chevron === "end" ? <FoldChevron /> : null}
    </button>
  );
}

export interface FoldContentProps {
  children: ReactNode;
  className?: string;
  /** 折叠后保留 DOM（如需在折叠内容里搜索）；默认折叠后卸载。 */
  keepMounted?: boolean;
}

export function FoldContent({ children, className, keepMounted = false }: FoldContentProps) {
  const { open, contentId } = useFold();
  const reduceMotion = useReducedMotion() === true;
  const transition = {
    duration: reduceMotion ? 0 : FOLD_DURATION_SECONDS,
    ease: "easeOut" as const,
  };

  if (keepMounted) {
    return (
      <motion.div
        id={contentId}
        data-slot="fold-content"
        initial={false}
        animate={{ height: open ? "auto" : 0 }}
        transition={transition}
        aria-hidden={!open}
        inert={!open}
        className={cn("overflow-hidden", className)}
      >
        {children}
      </motion.div>
    );
  }

  // initial={false}：首次挂载（含虚拟列表回收后重新挂载）不播放展开动画。
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="fold-content"
          id={contentId}
          data-slot="fold-content"
          initial={{ height: 0 }}
          animate={{ height: "auto" }}
          exit={{ height: 0 }}
          transition={transition}
          className={cn("overflow-hidden", className)}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
