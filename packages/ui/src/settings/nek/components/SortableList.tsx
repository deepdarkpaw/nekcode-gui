/**
 * 可拖拽排序的列表（改造自 model-provider-section/SortableProviderModelList）：
 * - 指针拖拽（移动 6px 后启动，交互控件上不启动）；
 * - 键盘：行获得焦点后 Alt+↑ / Alt+↓ 移动一位；↑ / ↓ 在行间移动焦点；
 * - 拖拽手柄有 aria-label 与 title。
 */
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { GripVerticalIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { isImeComposing } from "@/lib/imeComposition.js";

const INTERACTIVE_SELECTOR =
  "button:not([data-drag-handle]), input, textarea, select, a, [role=switch], [role=checkbox], [role=combobox], [contenteditable=true]";

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
}

class RowPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: ReactPointerEvent) => !isInteractiveTarget(nativeEvent.target),
    },
  ];
}

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) {
    return [...items];
  }
  return arrayMove([...items], from, to);
}

/** 列表行之间的 ↑ / ↓ 焦点移动（行元素需带 `data-nek-row`）。 */
export function handleRowArrowNavigation(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || isImeComposing(event)) {
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-nek-row]");
  if (!row || row !== event.target) {
    return;
  }
  const list = row.parentElement?.closest("[data-nek-list]") ?? row.parentElement;
  const rows = Array.from(list?.querySelectorAll<HTMLElement>("[data-nek-row]") ?? []);
  const next = rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)];
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

function SortableRow({
  id,
  index,
  count,
  dragLabel,
  onMove,
  children,
}: {
  id: string;
  index: number;
  count: number;
  dragLabel: string;
  onMove: (from: number, to: number) => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || isImeComposing(event)) {
      return;
    }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const to = event.key === "ArrowUp" ? index - 1 : index + 1;
      if (to >= 0 && to < count) {
        onMove(index, to);
      }
      return;
    }
    handleRowArrowNavigation(event);
  };
  return (
    <div
      ref={setNodeRef}
      data-nek-row=""
      tabIndex={0}
      aria-roledescription={dragLabel}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex min-w-0 items-center gap-2 border-b border-border outline-none last:border-b-0 focus-visible:bg-hover",
        isDragging && "relative z-10 rounded-md bg-card shadow-md",
      )}
      onKeyDown={handleKeyDown}
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        data-drag-handle=""
        tabIndex={-1}
        aria-label={dragLabel}
        title={dragLabel}
        className="flex h-8 w-5 shrink-0 cursor-grab items-center justify-center text-foreground-subtlest active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function SortableList({
  ids,
  onReorder,
  renderItem,
  dragLabel,
  className,
}: {
  ids: readonly string[];
  onReorder: (ids: string[]) => void;
  renderItem: (id: string, index: number) => ReactNode;
  /** 如"拖动排序；Alt+↑/↓ 移动"。 */
  dragLabel: string;
  className?: string;
}) {
  const sensors = useSensors(
    useSensor(RowPointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const move = (from: number, to: number) => onReorder(moveItem(ids, from, to));
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event: DragEndEvent) => {
        if (!event.over) {
          return;
        }
        move(ids.indexOf(String(event.active.id)), ids.indexOf(String(event.over.id)));
      }}
    >
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        <div data-nek-list="" className={className}>
          {ids.map((id, index) => (
            <SortableRow
              key={id}
              id={id}
              index={index}
              count={ids.length}
              dragLabel={dragLabel}
              onMove={move}
            >
              {renderItem(id, index)}
            </SortableRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
