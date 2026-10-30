import { describe, expect, it } from "vitest";
import {
  anchorActionAfterContentChange,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  shouldShowBackToBottom,
} from "./timelineScrollAnchor.js";

describe("timeline follow-bottom state", () => {
  it("N4: user scrolling away from the bottom disables follow and shows the action", () => {
    const following = resolveFollowingAfterScroll({
      following: true,
      source: "user",
      metrics: { scrollTop: 100, viewportHeight: 100, contentHeight: 1_000 },
    });
    expect(following).toBe(false);
    expect(shouldShowBackToBottom(following, 4)).toBe(true);
  });

  it("N5: new content sticks only while follow is owned by the user", () => {
    expect(anchorActionAfterContentChange(true)).toBe("stickToBottom");
    expect(anchorActionAfterContentChange(false)).toBe("hold");
  });

  it("N6: a programmatic scroll cannot steal the user's detached position", () => {
    expect(
      resolveFollowingAfterScroll({
        following: false,
        source: "programmatic",
        metrics: { scrollTop: 0, viewportHeight: 100, contentHeight: 1_000 },
      }),
    ).toBe(false);
    expect(
      reconcileFollowingForContentAnchor({
        following: true,
        lastObservedScrollTop: 600,
        userScrollIntent: "awayFromBottom",
        metrics: { scrollTop: 500, viewportHeight: 100, contentHeight: 1_000 },
      }),
    ).toBe(false);
  });
});
