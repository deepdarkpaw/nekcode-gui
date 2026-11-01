import { useConfirmDialogStore, type ConfirmDialogRequest } from "@/store/confirmDialogStore.js";

export function useConfirmDialog(): (payload: ConfirmDialogRequest) => Promise<boolean> {
  return useConfirmDialogStore((state) => state.requestConfirmation);
}
