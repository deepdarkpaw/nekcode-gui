// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationDeferredContent } from "./ConversationDeferredContent.js";

const bytes = new TextEncoder().encode(
  JSON.stringify("A".repeat(65535) + "B".repeat(65536) + "C".repeat(5000)),
);
const reference = {
  ref: "opaque",
  pointer: "/message/content",
  totalBytes: bytes.length,
  mediaType: "application/json",
  encoding: "base64" as const,
};
const result = (offset: number, limit: number) => {
  const value = bytes.slice(offset, offset + limit);
  const end = offset + value.length;
  return {
    ref: "opaque",
    offset,
    totalBytes: bytes.length,
    mediaType: "application/json",
    encoding: "base64" as const,
    data: btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join("")),
    ...(end < bytes.length ? { nextOffset: end } : {}),
    atSeq: 1,
    atRevision: 1,
    atLogEpoch: "epoch",
  };
};
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ZCodeIntlProvider initialLocale="zh-CN">
    <TooltipProvider>{children}</TooltipProvider>
  </ZCodeIntlProvider>
);
afterEach(cleanup);

it("HP3/RH5: deferred content fetches only an explicit chunk and replaces, rather than accumulating, the preview", async () => {
  const read = vi.fn(async ({ offset = 0, limit = 65536 }) => result(offset, limit));
  const ui = render(<ConversationDeferredContent reference={reference} read={read} />, { wrapper });
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /按需查看内容/ }));
  await waitFor(() => expect(ui.container.querySelector("pre")).not.toBeNull());
  expect(read).toHaveBeenCalledTimes(1);
  expect(ui.container.querySelector("pre")!.textContent!.length).toBeLessThanOrEqual(65536);
  fireEvent.click(screen.getByRole("button", { name: "下一段" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(ui.container.querySelector("pre")!.textContent).toBe("B".repeat(65536)),
  );
  expect(read.mock.calls[1]![0]).toEqual({ ref: "opaque", offset: 65536, limit: 65536 });
  fireEvent.click(screen.getByRole("button", { name: "上一段" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(read.mock.calls[2]![0].offset).toBe(0);
});

it("HP5: foreign or non-advancing content slices fail visibly instead of showing partial success", async () => {
  const read = vi.fn(async () => ({ ...result(0, 65536), nextOffset: 0 }));
  const ui = render(<ConversationDeferredContent reference={reference} read={read} />, { wrapper });
  fireEvent.click(screen.getByRole("button", { name: /按需查看内容/ }));
  await waitFor(() => expect(ui.container.querySelector('[aria-invalid="true"]')).not.toBeNull());
  expect(ui.container.querySelector("pre")).toBeNull();
});

it("SL3/HP9: a readonly public view has no local content capability", () => {
  const ui = render(<ConversationDeferredContent reference={reference} />, { wrapper });
  expect(ui.container.querySelector("button")).toBeNull();
  expect(ui.container.innerHTML).not.toContain("opaque");
});
