import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { resolveBuildEnvironment } from "../build-environment.mjs";

const root = new URL("../../", import.meta.url);

/** Legacy registry/configuration sources must be removed, not merely left unregistered. */
test("legacy provider packages, runtime and materialization paths stay retired", async () => {
  for (const path of [
    "packages/provider/package.json",
    "packages/provider-node/package.json",
    "packages/model-option-map/package.json",
    "packages/services/src/model-provider/providerRuntime.ts",
    "packages/services/src/model-provider/providerConfigRuntime.ts",
    "packages/services/src/model-provider/providerFacadeServices.ts",
    "packages/services/src/model-provider/providerProvisioningSource.ts",
    "packages/services/src/model-provider/providerProvisioningTarget.ts",
    "packages/desktop/src/main/desktopProviderConfig.ts",
    "packages/desktop/src/main/providerProvisioningEnvironmentCoordinator.ts",
    "packages/desktop/src/host/remoteProviderProvisioningService.ts",
    "packages/ui/src/hooks/useBuiltinProviderConfigFile.ts",
    "config/provider/zcode-builtin.json",
    "scripts/ci/self-managed-models-smoke.mjs",
    "scripts/ci/fixtures/self-managed-models.jsx",
  ]) {
    await assert.rejects(access(new URL(path, root)), { code: "ENOENT" }, path);
  }
  for (const path of [
    "package.json",
    ...["desktop", "services", "shared", "ui"].map((name) => `packages/${name}/package.json`),
  ]) {
    assert.doesNotMatch(
      await readFile(new URL(path, root), "utf8"),
      /@zcode\/(provider(?:-node)?|model-option-map)|packages\/provider/,
    );
  }
});

test("RPC and host startup expose nek selection without provider provisioning or config IPC", async () => {
  const { RemoteServiceAccess } = await tsImport(
    "../../packages/client/src/remoteServiceAccess.ts",
    import.meta.url,
  );
  const {
    ServiceChannels,
    PlatformChannels,
    hostInitLocalMessageSchema,
    hostIncomingMessageSchema,
  } = await tsImport("../../packages/shared/src/index.ts", import.meta.url);
  const channels = [];
  new RemoteServiceAccess({
    getChannel(name) {
      channels.push(name);
      return { call: async () => undefined, listen: () => () => {} };
    },
  });
  assert.ok(channels.includes(ServiceChannels.ModelSelection));
  assert.ok(!channels.includes("provider-settings"));
  assert.ok(!channels.includes("provider-provisioning-target"));
  assert.ok(!("GetBuiltinProviderConfigFile" in PlatformChannels));
  assert.ok(hostInitLocalMessageSchema.safeParse({ type: "init-local" }).success);
  assert.equal(
    hostIncomingMessageSchema.safeParse({
      type: "provider-provisioning-execute",
      requestId: "retired",
      environmentKey: "remote",
      remoteSessionId: "session",
      trigger: "environment-online",
    }).success,
    false,
  );
  for (const path of [
    "packages/services/src/createLocalServices.ts",
    "packages/desktop/src/main/desktopRemoteSessions.ts",
    "packages/desktop/src/host/index.ts",
    "packages/server/src/entry-stdio.ts",
    "packages/zcode-server-cli/src/server-core/core.ts",
  ]) {
    assert.doesNotMatch(
      await readFile(new URL(path, root), "utf8"),
      /[Pp]roviderProvisioning|zcodeBuiltinProviderConfig|provider_config\.json/,
    );
  }
});

test("build environment resolution keeps existing semantics without any provider config file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nek-build-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await resolveBuildEnvironment({ root: directory, env: {} }), "test");
  await writeFile(join(directory, ".env.production"), "ZCODE_ENV=production\n");
  assert.equal(
    await resolveBuildEnvironment({ root: directory, env: { NODE_ENV: "production" } }),
    "production",
  );
  assert.equal(
    await resolveBuildEnvironment({ root: directory, env: { ZCODE_ENV: " TEST " } }),
    "test",
  );
  await assert.rejects(
    resolveBuildEnvironment({ root: directory, env: { ZCODE_ENV: "invalid" } }),
    /Invalid ZCODE_ENV/,
  );
});
