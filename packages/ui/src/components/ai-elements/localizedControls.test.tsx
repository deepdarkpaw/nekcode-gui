// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ArtifactClose } from "./artifact.js";
import { MessageBranch, MessageBranchNext, MessageBranchPrevious } from "./message.js";
import { PromptInput } from "./prompt-input.js";
import { SnippetCopyButton } from "./snippet.js";

afterEach(cleanup);

it("ZR-6 ai-elements use the app language for accessible names and titles", () => {
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <MessageBranch>
        <MessageBranchPrevious />
        <MessageBranchNext />
      </MessageBranch>
      <PromptInput onSubmit={() => undefined} />
      <SnippetCopyButton />
      <ArtifactClose />
    </ZCodeIntlProvider>,
  );

  expect(screen.getByRole("button", { name: "上一条分支" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "下一条分支" })).toBeTruthy();
  expect(screen.getByLabelText("上传文件").getAttribute("title")).toBe("上传文件");
  expect(screen.getByRole("button", { name: "复制" }).getAttribute("title")).toBe("复制");
  expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
});
