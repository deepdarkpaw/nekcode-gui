import { NEK_INTERACTION_FEED_METHODS as hostMethods } from "@zcode/services";
import { describe, expect, it } from "vitest";
import { NEK_AGENT_FEED_METHODS as rendererMethods } from "./nekAgentFeed.js";

describe("nek interaction feed RPC whitelist", () => {
  it("keeps renderer and host method names aligned", () => {
    expect(rendererMethods).toEqual(hostMethods);
    expect(rendererMethods).toEqual([
      "onDynamicNekInteractionFrame",
      "respondNekInteraction",
      "stopSubagent",
      "getSubagentTranscript",
      "listAgentTypes",
    ]);
  });
});
