import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { ManifestUpdateProvider } = await tsImport(
  "../../packages/desktop/src/main/manifestUpdateProvider.ts",
  import.meta.url,
);

test("update manifest requests select platform/channel without a device query or header", async () => {
  const provider = new ManifestUpdateProvider(
    {
      provider: "custom",
      endpointOrigin: "https://updates.example",
      releasePlatform: "linux-x86_64",
      releaseChannel: "stable",
      deviceMid: "obsolete-device-value",
    },
    {},
    { executor: {}, isUseMultipleRangeRequest: false },
  );
  let request;
  provider.httpRequest = async (url, headers) => {
    request = { url, headers: new Headers(headers) };
    return "version: 1.2.3\nfiles: []\n";
  };
  assert.equal((await provider.getLatestVersion()).version, "1.2.3");
  assert.deepEqual([...request.url.searchParams.keys()].sort(), ["channel", "platform"]);
  assert.equal(request.url.searchParams.get("platform"), "linux-x86_64");
  assert.equal(request.headers.has("x-device-mid"), false);
  assert.equal(request.headers.get("x-release-channel"), "1");
});
