/**
 * 失效/读取模型（`IModelSelectionService` + `NekModelFactsSource`）的契约：
 * - `onDidChange` 是失效信号（无快照），消费者自己重读；
 * - `getView()` 每次都读事实，没有跨调用的缓存可以变旧；
 * - 读取期间发生配置变化不会丢：被更新读取超车的那次会重读，而不是把旧目录当当前事实；
 * - 重载失败直接抛错（可见、可重试），重试真的重新重载。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NekModelFactsReloadError } from "../src/model-provider/nekModelFacts.js";
import { createNekModelFactsSource } from "../src/model-provider/nekModelFacts.js";
import { createNekModelSelectionService } from "../src/model-provider/nekModelSelectionService.js";
import { catalogModel, countCalls, createFakeFactsApi, waitFor } from "./nekModelFactsFixture.js";

const CUSTOM = catalogModel({ provider: "mock", id: "mock-model" });
const CUSTOM_2 = catalogModel({ provider: "mock", id: "mock-model-2" });

function serviceOf(api: ReturnType<typeof createFakeFactsApi>) {
  return createNekModelSelectionService({ facts: createNekModelFactsSource(api) });
}

test("onDidChange 只是失效信号：没有快照，订阅者按信号重读", async () => {
  const api = createFakeFactsApi({ available: [CUSTOM], catalog: [CUSTOM] });
  const service = serviceOf(api);
  const payloads: unknown[] = [];
  service.onDidChange((...args: unknown[]) => payloads.push(args));
  await service.getView();

  api.setCatalog([CUSTOM, CUSTOM_2], [CUSTOM, CUSTOM_2]);
  api.notifyWatch();
  await waitFor(() => payloads.length === 1);
  assert.deepEqual(payloads[0], [], "失效信号不携带视图快照");

  const view = await service.getView();
  assert.deepEqual(
    view.providers[0]?.models.map((model) => model.modelId),
    ["mock-model", "mock-model-2"],
  );
  service.dispose();
});

test("getView 每次读事实：同一内容重读不推进版本，新模型推进一次", async () => {
  const api = createFakeFactsApi({ available: [CUSTOM], catalog: [CUSTOM] });
  const service = serviceOf(api);
  const first = await service.getView();
  const readsAfterFirst = countCalls(api, "listAvailableModels");
  const second = await service.getView();
  assert.equal(countCalls(api, "listAvailableModels"), readsAfterFirst + 1);
  assert.equal(second.revision, first.revision);

  api.setCatalog([CUSTOM, CUSTOM_2], [CUSTOM, CUSTOM_2]);
  const third = await service.getView();
  assert.equal(third.revision, first.revision + 1);
  service.dispose();
});

test("读取期间配置变化不丢：被超车的读取会重读，返回的不是旧目录", async () => {
  const api = createFakeFactsApi({ available: [CUSTOM], catalog: [CUSTOM] });
  const service = serviceOf(api);

  // 两次读取都卡在闸门上，最后按 B、A 的顺序放行（B 先完成 = A 被超车）。
  const gateA = api.gateNextRead();
  const gateB = api.gateNextRead();
  const readA = service.getView();
  await waitFor(() => countCalls(api, "listAvailableModels") === 1);
  api.setCatalog([CUSTOM, CUSTOM_2], [CUSTOM, CUSTOM_2]);
  const readB = service.getView();
  await waitFor(() => countCalls(api, "listAvailableModels") === 2);

  gateB.resolve();
  const newer = await readB;
  assert.equal(newer.providers[0]?.models.length, 2);

  gateA.resolve();
  const older = await readA;
  // A 读到的目录已被 B 超越：它必须重读，不能把只有 1 个模型的旧目录当成当前事实。
  assert.equal(older.providers[0]?.models.length, 2);
  assert.equal(older.revision, newer.revision);

  // 之后的读取仍然是同一版本（内容没再变）。
  const settled = await service.getView();
  assert.equal(settled.revision, newer.revision);
  service.dispose();
});

test("重载失败经 getView 可见：抛重载错误，修好后的重试真的重载", async () => {
  const api = createFakeFactsApi({
    available: [CUSTOM],
    catalog: [CUSTOM],
    reloadError: new Error("control process crashed"),
  });
  const service = serviceOf(api);
  await service.getView();

  api.notifyWatch();
  await assert.rejects(() => service.getView(), NekModelFactsReloadError);

  api.setReloadError(undefined);
  api.setCatalog([CUSTOM, CUSTOM_2], [CUSTOM, CUSTOM_2]);
  const recovered = await service.getView();
  assert.equal(countCalls(api, "reloadRunningSessions"), 2);
  assert.equal(recovered.providers[0]?.models.length, 2);
  service.dispose();
});

test("读取失败同样抛出（不伪装成空表）", async () => {
  const failure = new Error("models.json 解析失败");
  const api = createFakeFactsApi({ readError: failure });
  const service = serviceOf(api);
  await assert.rejects(
    () => service.getView(),
    (error: unknown) => error === failure,
  );
  api.setReadError(undefined);
  api.setCatalog([CUSTOM], [CUSTOM]);
  assert.equal((await service.getView()).providers[0]?.models.length, 1);
  service.dispose();
});

test("多订阅、退订与 dispose：watch 随服务释放，dispose 后拒绝读取", async () => {
  const api = createFakeFactsApi({ available: [CUSTOM], catalog: [CUSTOM] });
  const service = serviceOf(api);
  const received: string[] = [];
  const first = service.onDidChange(() => received.push("first"));
  const second = service.onDidChange(() => received.push("second"));
  await service.getView();

  api.notifyWatch();
  await waitFor(() => received.length === 2);
  assert.deepEqual([...received].sort(), ["first", "second"]);

  first.dispose();
  api.notifyWatch();
  await waitFor(() => received.length === 3);
  assert.equal(received.filter((entry) => entry === "first").length, 1);

  assert.equal(api.watchDisposed, 0);
  second.dispose();
  service.dispose();
  assert.equal(api.watchDisposed, 1);
  await assert.rejects(() => service.getView(), /已 dispose/u);
});
