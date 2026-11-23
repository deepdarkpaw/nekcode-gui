import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { NekMcpServerConfig } from "@zcode/shared/nek-protocol";
import {
  AGENT_DIR,
  LOCAL,
  PROJECT,
  PROJECT_DIR,
  createHarness,
  expectNekError,
  readJson,
} from "./nekConfigApiHarness.js";

const MCP_PATH = join(AGENT_DIR, "mcp.json");
const PROJECT_MCP_PATH = join(PROJECT_DIR, "mcp.json");
const LEGACY = {
  type: "streamable-http",
  url: "https://example.test/mcp",
  timeout: 0.25,
  enabled: true,
  exposure: "codemode",
  toolExposure: { search: "codemode-deferred", "get-*": "codemode" },
  oauth: {
    clientName: " my MCP client ",
    callbackUrl: "http://[::1]:5432/callback",
    callbackPort: 5432,
    authServerMetadataUrl: "http://localhost:65535/metadata",
    futureOauthField: { keep: true },
  },
  futureField: { keep: true },
} as const;

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

test("NM-6 imports and writes streamable HTTP and both exposure aliases without normalizing them", async (t) => {
  const { api, local } = createHarness({
    localFiles: {
      [MCP_PATH]: JSON.stringify({ futureTopLevel: [1], mcpServers: { invalidSibling: false } }),
    },
  });
  t.after(() => api.dispose());
  const initial = await api.readMcpConfig(LOCAL, "global");
  const implicit = { url: "https://example.test/mcp", exposure: "codemode-deferred" };
  const imported = await api.previewMcpImport(
    LOCAL,
    "global",
    JSON.stringify({ mcpServers: { Legacy: LEGACY, implicit } }),
  );
  assert.deepEqual(imported.errors, []);
  assert.deepEqual(
    imported.servers.map(({ config }) => config),
    [LEGACY, implicit],
  );
  const first = await api.saveMcpServer(LOCAL, "global", imported.servers[0]!, initial);
  const second = await api.saveMcpServer(LOCAL, "global", imported.servers[1]!, first);
  const original = (await api.readMcpConfig(LOCAL, "global")).servers.find(
    (entry) => entry.name === "Legacy",
  )!;
  const third = await api.saveMcpServer(
    LOCAL,
    "global",
    {
      name: original.name,
      previousName: original.name,
      config: { ...original.config, description: "new description" },
    },
    second,
  );
  await api.setMcpServerOverride(
    LOCAL,
    "Legacy",
    { enabled: false },
    { ...third, scope: "global" },
  );
  assert.deepEqual(readJson(local, MCP_PATH), {
    futureTopLevel: [1],
    mcpServers: {
      invalidSibling: false,
      Legacy: { ...LEGACY, description: "new description", enabled: false },
      implicit,
    },
  });
});

test("NM-6 rejects unsupported transports, auth and invalid OAuth with a reason per field", async (t) => {
  const { api, local } = createHarness();
  t.after(() => api.dispose());
  const view = await api.readMcpConfig(LOCAL, "global");
  const cases = [
    [
      { ...LEGACY, type: "sse" },
      "type",
      /legacy SSE transport is not supported; use the streamable HTTP URL/u,
    ],
    [
      { ...LEGACY, auth: { provider: "token" } },
      "auth",
      /auth.provider is not supported; use OAuth or an Authorization header/u,
    ],
    [{ ...LEGACY, url: "ftp://example.test/mcp" }, "url", /url must be an http or https URL/u],
    [{ ...LEGACY, timeout: 0 }, "timeout", /timeout must be a positive number of seconds/u],
    [{ ...LEGACY, exposure: "unknown" }, "exposure", /exposure must be one of/u],
    [
      { ...LEGACY, toolExposure: { tool: "unknown" } },
      "toolExposure",
      /toolExposure "tool" must be one of/u,
    ],
    [{ ...LEGACY, oauth: { callbackPort: 65536 } }, "oauth.callbackPort", /must be a port number/u],
    [{ ...LEGACY, oauth: { callbackPort: 1.5 } }, "oauth.callbackPort", /must be a port number/u],
    [
      { ...LEGACY, oauth: { callbackUrl: "http://localhost/callback?x" } },
      "oauth.callbackUrl",
      /without query or fragment/u,
    ],
    [
      { ...LEGACY, oauth: { callbackUrl: "https://localhost/callback" } },
      "oauth.callbackUrl",
      /must be an http URI/u,
    ],
    [
      { ...LEGACY, oauth: { callbackUrl: "http://localhost:1234", callbackPort: 4321 } },
      "oauth.callbackUrl",
      /name different ports/u,
    ],
    [{ ...LEGACY, oauth: { clientName: " " } }, "oauth.clientName", /must be a non-empty string/u],
    [
      { ...LEGACY, oauth: { authServerMetadataUrl: "http://example.test/meta" } },
      "oauth.authServerMetadataUrl",
      /must be an https URL/u,
    ],
    [
      { ...LEGACY, oauth: { clientRegistration: {} } },
      "oauth.clientRegistration",
      /not supported/u,
    ],
    [{ ...LEGACY, oauth: { clientSecret: 123 } }, "oauth.clientSecret", /must be a string/u],
  ] as const;
  for (const [raw, field, reason] of cases) {
    const saveError = await expectNekError(
      () =>
        api.saveMcpServer(
          LOCAL,
          "global",
          {
            name: "demo",
            config: raw as unknown as NekMcpServerConfig,
          },
          view,
        ),
      "validation",
    );
    assert.match(saveError.fieldErrors?.[field] ?? "", reason);
    const preview = await api.previewMcpImport(LOCAL, "global", JSON.stringify({ demo: raw }));
    assert.deepEqual(preview.servers, []);
    assert.match(preview.errors.join("\n"), reason);
    assert.doesNotMatch(
      preview.errors.join("\n"),
      /invalid_union|invalid_type|expected string, received/iu,
    );
  }
  assert.equal(local.files.has(MCP_PATH), false);
});

test("NM-6 project preview, save and patches write only nek's override keys", async (t) => {
  const { api, local } = createHarness({
    localFiles: {
      [MCP_PATH]: JSON.stringify({ mcpServers: { Legacy: LEGACY } }),
    },
  });
  t.after(() => api.dispose());
  const view = await api.readMcpConfig(LOCAL, "project", PROJECT);
  const options = { ...view, cwd: PROJECT };
  const override = {
    enabled: false,
    exposure: "codemode-deferred",
    toolExposure: { search: "codemode" },
  } as const;
  const preview = await api.previewMcpImport(
    LOCAL,
    "project",
    JSON.stringify({ Legacy: override, orphan: override, invalid: LEGACY }),
    PROJECT,
  );
  assert.deepEqual(preview.servers, [{ name: "Legacy", config: override, conflict: false }]);
  assert.match(preview.errors.join("\n"), /needs a global server to override/u);
  assert.match(
    preview.errors.join("\n"),
    /an override can only set enabled, exposure, toolExposure/u,
  );
  await expectNekError(
    () => api.saveMcpServer(LOCAL, "project", { name: "Legacy", config: LEGACY }, options),
    "validation",
  );
  await expectNekError(
    () => api.saveMcpServer(LOCAL, "project", { name: "orphan", config: override }, options),
    "validation",
  );
  assert.equal(local.files.has(PROJECT_MCP_PATH), false);
  const saved = await api.saveMcpServer(
    LOCAL,
    "project",
    { name: "Legacy", config: override },
    options,
  );
  const setOptions = { ...saved, cwd: PROJECT, scope: "project" } as const;
  const patchError = await expectNekError(
    () =>
      api.setMcpServerOverride(
        LOCAL,
        "Legacy",
        {
          description: "must not leak into project",
        } as never,
        setOptions,
      ),
    "validation",
  );
  assert.match(patchError.fieldErrors?.config ?? "", /unexpected keys: description/u);
  await api.setMcpServerOverride(LOCAL, "Legacy", { enabled: true }, setOptions);
  assert.deepEqual(readJson(local, PROJECT_MCP_PATH), {
    mcpServers: { Legacy: { ...override, enabled: true } },
  });
  assert.deepEqual(readJson(local, MCP_PATH), { mcpServers: { Legacy: LEGACY } });
});
