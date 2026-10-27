import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { Cron } from "croner";

const { createClientScenesService } = await tsImport(
  "../../packages/services/src/client-scenes/clientScenesService.ts",
  import.meta.url,
);
const { mapClientScenesToAutomationTemplates, materializeScheduledTemplateDraft } = await tsImport(
  "../../packages/ui/src/settings/automationTemplateCatalog.ts",
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../../packages/ui/tsconfig.json", import.meta.url)),
  },
);

const forbiddenNetwork = {
  apiClient: {
    request() {
      throw new Error("network forbidden");
    },
  },
  resolveRequestContext() {
    throw new Error("endpoint/device context forbidden");
  },
};

test("bundled scheduled templates remain usable without any network context", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("fetch forbidden");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const response = await createClientScenesService(forbiddenNetwork).list();
  assert.equal(response.code, 0);
  const templates = mapClientScenesToAutomationTemplates(response.data, (value) => {
    const cron = new Cron(value, { paused: true });
    try {
      return Boolean(cron.nextRun());
    } finally {
      cron.stop();
    }
  });
  assert.deepEqual(templates.rejectedScheduledTemplateIds, []);
  assert.ok(templates.scheduled.length >= 3);
  assert.equal(Object.hasOwn(templates, "offPeak"), false);
  for (const locale of ["zh-CN", "en-US"]) {
    for (const template of templates.scheduled) {
      const draft = materializeScheduledTemplateDraft(template, locale);
      assert.ok(draft.title && draft.prompt);
      assert.equal(draft.cronExpr, template.cronExpr);
    }
  }
  assert.doesNotMatch(JSON.stringify(response), /https?:\/\//);
});

test("callers cannot mutate bundled scenes for later reads", async () => {
  const scenes = createClientScenesService(forbiddenNetwork);
  const expectedScenes = await scenes.list();
  const mutated = await scenes.list();
  mutated.data[0].options.prompts.items[0].contents.cn = "changed by caller";
  mutated.data.splice(1);
  assert.deepEqual(await scenes.list(), expectedScenes);
  assert.deepEqual(await createClientScenesService(forbiddenNetwork).list(), expectedScenes);
});
