import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Fold, FoldContent, FoldTrigger, resolveFoldKeyAction } from "./fold.js";

const key = (value: string, patch: Record<string, unknown> = {}) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...patch,
});

describe("resolveFoldKeyAction", () => {
  it("toggles on Space and Enter", () => {
    expect(resolveFoldKeyAction(key(" "), false)).toBe("toggle");
    expect(resolveFoldKeyAction(key("Enter"), false)).toBe("toggle");
  });

  it("collapses / expands with arrows only in tree mode", () => {
    expect(resolveFoldKeyAction(key("ArrowLeft"), true)).toBe("close");
    expect(resolveFoldKeyAction(key("ArrowRight"), true)).toBe("open");
    expect(resolveFoldKeyAction(key("ArrowLeft"), false)).toBe(null);
  });

  it("ignores modifier combos and IME composition", () => {
    expect(resolveFoldKeyAction(key("Enter", { ctrlKey: true }), false)).toBe(null);
    expect(resolveFoldKeyAction(key("Enter", { isComposing: true }), false)).toBe(null);
    expect(resolveFoldKeyAction(key("Enter", { keyCode: 229 }), false)).toBe(null);
  });
});

describe("Fold rendering", () => {
  const render = (props: { open?: boolean; defaultOpen?: boolean; focusable?: boolean }) =>
    renderToStaticMarkup(
      <Fold {...props}>
        <FoldTrigger>Title</FoldTrigger>
        <FoldContent>Body</FoldContent>
      </Fold>,
    );

  it("renders collapsed content unmounted with aria-expanded=false", () => {
    const html = render({});
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Body");
  });

  it("renders open content linked to the trigger", () => {
    const html = render({ defaultOpen: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Body");
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
  });

  it("respects the controlled prop over defaultOpen", () => {
    expect(render({ open: false, defaultOpen: true })).not.toContain("Body");
  });

  it("makes the card focusable when requested", () => {
    expect(render({ focusable: true })).toContain('tabindex="0"');
  });
});
