import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_GUI_RUNTIME_CONFIG } from "@zcode/shared/guiRuntimeConfig";
import { createNekRuntimeServices } from "../src/createNekRuntimeServices.js";
import { createMemoryNekConfigHostExecutor } from "../src/nek-config-api/index.js";
import { guiInfo } from "./nekSessionHarness.js";

for (const override of [undefined, 4321]) {
  test(`ML4: production runtime composition forwards model deadline and respects explicit override (${override})`, async () => {
    const executor = createMemoryNekConfigHostExecutor({ agentDir: ".tmp/runtime-config/agent" });
    const runtimeConfig = {
      ...DEFAULT_GUI_RUNTIME_CONFIG,
      timeouts: { ...DEFAULT_GUI_RUNTIME_CONFIG.timeouts, modelReadMs: 1234 },
    };
    const runtime = createNekRuntimeServices({
      agent: { guiInfo, runtimeConfig },
      config: {
        hosts: { executor: () => executor, listTargets: async () => [] },
        ...(override === undefined ? {} : { config: { modelReadMs: override } }),
      },
    });
    try {
      assert.equal(runtime.configApi.modelReadMs, override ?? 1234);
    } finally {
      await runtime.agentService.dispose();
      runtime.configApi.dispose();
    }
  });
}
