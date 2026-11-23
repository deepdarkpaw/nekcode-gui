import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_DIR, LOCAL, createHarness, expectNekError } from "./nekConfigApiHarness.js";

const MCP_PATH = join(AGENT_DIR, "mcp.json");

test("NM-5 validates the same raw MCP names at save, override and import", async (t) => {
  const { api, local } = createHarness();
  t.after(() => api.dispose());
  const revision = (await api.readMcpConfig(LOCAL, "global")).revision;
  const config = { command: "node" };
  for (const name of ["vendor.ai", " Vendor_AI", "Vendor_AI ", "中文", ""]) {
    const saved = await expectNekError(
      () => api.saveMcpServer(LOCAL, "global", { name, config }, { revision }),
      "validation",
    );
    assert.match(saved.fieldErrors?.name ?? "", /use letters, digits, "_" and "-"/u);
    const patched = await expectNekError(
      () =>
        api.setMcpServerOverride(LOCAL, name, { enabled: false }, { revision, scope: "global" }),
      "validation",
    );
    assert.deepEqual(patched.fieldErrors, saved.fieldErrors);
    const preview = await api.previewMcpImport(LOCAL, "global", JSON.stringify({ [name]: config }));
    assert.deepEqual(preview.servers, []);
    assert.deepEqual(preview.errors, [saved.message]);
  }
  assert.equal(local.files.has(MCP_PATH), false);
  const name = "Vendor_AI-2";
  await api.saveMcpServer(LOCAL, "global", { name, config }, { revision });
  assert.equal((await api.readMcpConfig(LOCAL, "global")).servers[0]?.name, name);
});
