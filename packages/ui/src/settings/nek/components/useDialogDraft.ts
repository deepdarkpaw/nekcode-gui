/**
 * 对话框草稿：只在对话框打开时用初始值重置；打开期间初始值变化（例如外部修改后"保留我的修改"
 * 重新读取了底层数据）不覆盖用户的草稿。"重新载入"由文档 resetToken 触发显式重置。
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export function useDialogDraft<T>(
  open: boolean,
  initial: T,
): [T, Dispatch<SetStateAction<T>>, () => void] {
  const [draft, setDraft] = useState(initial);
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    if (open) {
      setDraft(initialRef.current);
    }
  }, [open]);
  return [draft, setDraft, () => setDraft(initialRef.current)];
}
