import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { releaseUpdateInfoNames } from "./desktop-release.mjs";
import { desktopProductIdentities } from "../../packages/desktop/scripts/desktop-product-identity.mjs";

// 直接解析真实工作流（公开入口），断言 job 条件与 needs 图语义，
// 而不是复制一份手写函数；工作流文件是唯一事实来源。
const root = resolve(import.meta.dirname, "../..");
const workflowPath = resolve(root, ".github/workflows/desktop.yml");
const setupActionPath = resolve(root, ".github/actions/setup-workspace/action.yml");

async function loadJobs() {
  const document = parse(await readFile(workflowPath, "utf8"));
  return document.jobs;
}

async function loadWorkflow() {
  return parse(await readFile(workflowPath, "utf8"));
}

const uses = (job, prefix) =>
  job.steps.filter((step) => String(step.uses ?? "").startsWith(prefix));

const runSteps = (job) => job.steps.filter((step) => typeof step.run === "string");

/** job 真正执行的命令：step.run 加上矩阵车道携带的命令块。 */
const runCommands = (job) => [
  ...runSteps(job).map((step) => String(step.run)),
  ...(job.strategy?.matrix?.lane ?? []).map((lane) => String(lane.commands ?? "")),
];

/** 覆盖集合：把指定 job 的全部命令并成一段文本。 */
const allCommands = (jobs, ids) => ids.flatMap((id) => runCommands(jobs[id])).join("\n");

/** 整个工作流的命令文本（含并行车道）。 */
const allRuns = (jobs) => Object.values(jobs).flatMap(runCommands).join("\n");

test("desktop workflow is valid YAML with the expected jobs", async () => {
  const jobs = await loadJobs();
  assert.deepEqual(Object.keys(jobs).sort(), [
    "browser-checks",
    "build",
    "build-macos",
    "checks",
    "release",
    "remote-assets",
    "tests",
  ]);
});

test("packaged smoke only executes native targets and puts evidence in runner.temp", async () => {
  const jobs = await loadJobs();
  for (const id of ["build", "build-macos"]) {
    const smoke = jobs[id].steps.find((step) => step.name === "Packaged startup smoke");
    assert.ok(smoke);
    for (const key of ["TMPDIR", "TMP", "TEMP"]) assert.equal(smoke.env[key], "${{ runner.temp }}");
    assert.equal(smoke["continue-on-error"], undefined);
    if (id === "build") assert.equal(smoke.if, "${{ !matrix.target.crossArch }}");
    else assert.match(smoke.run, /\$\{#apps\[@\]\}/u);
    const artifacts = jobs[id].steps.find(
      (step) => step.name === "Upload packaged smoke artifacts",
    );
    assert.equal(artifacts.if, "${{ failure() }}");
    assert.match(artifacts.with.path, /runner.temp/u);
  }
});

test("remote assets start independently of checks and only gate on cancellation", async () => {
  const jobs = await loadJobs();
  const assets = jobs["remote-assets"];
  // coverage 不生产远端资产；不能让独立 producer 白等整段检查完成。
  assert.equal(assets.needs, undefined);
  assert.equal(String(assets.if).trim(), "${{ !cancelled() }}");
  // 明确不按 checks 的 success 结果门禁，否则 checks 红时资产 job 会被跳过。
  assert.doesNotMatch(String(assets.if), /needs\.checks\.result|success\(\)/);
  assert.equal(uses(assets, "actions/upload-artifact").length, 1);
});

test("build consumes real assets, not checks success, and never silently falls back", async () => {
  const jobs = await loadJobs();
  for (const id of ["build", "build-macos"]) {
    const job = jobs[id];
    assert.deepEqual(job.needs, "remote-assets");
    const condition = String(job.if);
    assert.match(condition, /!cancelled\(\)/);
    assert.match(condition, /needs\.remote-assets\.result == 'success'/);
    // 只看 assets 成功，不因 checks 失败跳过打包。
    assert.doesNotMatch(condition, /needs\.checks\.result/);
    const downloads = uses(job, "actions/download-artifact").filter(
      (step) => step.with?.name === "bundled-remote-linux-x64",
    );
    assert.equal(downloads.length, 1);
    for (const step of job.steps) {
      assert.notEqual(step["continue-on-error"], true);
      if (step.uses?.startsWith("actions/download-artifact"))
        assert.notEqual(step.with?.["if-no-files-found"], "ignore");
    }
  }
});

test("parallel packaging preserves coverage commands, full targets and current-run artifact ownership", async () => {
  const jobs = await loadJobs();
  // 每条原命令在并行结构里只能平移、不能删：checks 负责静态门禁，tests 车道负责测试，
  // browser-checks 负责浏览器冒烟。
  const commands = await allCommands(jobs, ["checks", "tests", "browser-checks"]);
  for (const command of [
    "pnpm typecheck",
    "pnpm gate:lint",
    "pnpm gate:format",
    "pnpm gate:knip",
    "pnpm architecture:check",
    "pnpm vitest run --dir packages/client/src",
    "pnpm vitest run --dir packages/server/src",
    "pnpm vitest run --dir packages/desktop/src --exclude '**/ipcSignalFanout.test.ts'",
    "pnpm vitest run packages/desktop/scripts/build-metadata.test.ts scripts/rolling-app-version.test.ts",
    "pnpm --filter @zcode/ui exec vitest run src",
    "node --import tsx --test packages/services/test/*.test.ts",
    "node --import tsx --test packages/shared/test/*.test.ts packages/shared/src/node/*.test.ts packages/desktop/src/preload/ipcSignalFanout.test.ts",
    "node --test --test-isolation=none scripts/ci/*.test.mjs",
    "node scripts/ci/remote-form-smoke.mjs",
    "node scripts/ci/conversation-navigator-smoke.mjs",
    "node scripts/ci/local-share-context-smoke.mjs",
    "node scripts/ci/session-local-errors-smoke.mjs",
    "node scripts/ci/local-onboarding-smoke.mjs",
    "node scripts/ci/no-official-purchase-smoke.mjs",
    "node scripts/ci/local-preferences-smoke.mjs",
    "node scripts/ci/root-startup-smoke.mjs",
    "node scripts/ci/conversation-export-smoke.mjs",
    "node scripts/ci/conversation-import-smoke.mjs",
  ]) {
    assert.ok(commands.includes(command), `missing coverage command: ${command}`);
  }
  for (const id of ["build", "build-macos"]) {
    const job = jobs[id];
    assert.equal(job.env?.ZCODE_DESKTOP_LINUX_TARGETS, undefined);
    for (const download of uses(job, "actions/download-artifact")) {
      assert.equal(download.with?.["run-id"], undefined);
      assert.equal(download.with?.repository, undefined);
    }
    const jobCommands = job.steps.map((step) => step.run ?? "");
    const verify = jobCommands.indexOf("node scripts/bundle-remote-assets.mjs verify");
    const prepare = jobCommands.indexOf("pnpm prepare:desktop-runtime");
    const build = jobCommands.indexOf("pnpm build:bootstrap");
    assert.ok(verify >= 0 && prepare > verify && build > prepare);
    assert.ok(jobCommands.some((command) => command.includes("--skip-prepare --skip-build")));
  }
});

test("checks job runs the three gate ratchets exactly, without bypass wrappers", async () => {
  const jobs = await loadJobs();
  // 门禁必须按精确命令串出现在 checks 里：任何前缀/后缀都可能被包装成不失败。
  const gateSteps = jobs.checks.steps.filter((step) =>
    /pnpm gate:(lint|format|knip)\b/.test(String(step.run ?? "")),
  );
  assert.deepEqual(
    gateSteps.map((step) => String(step.run).trim()),
    ["pnpm gate:lint", "pnpm gate:format", "pnpm gate:knip"],
  );
  for (const step of gateSteps) {
    // CI 不得包装门禁：continue-on-error / || true / exit 0 都会把回归降级成通过。
    assert.equal(step["continue-on-error"], undefined);
    assert.doesNotMatch(String(step.run), /\|\|\s*true|;\s*exit 0\b/);
    // 只跳过前置失败与取消，不用 always()/success() 改写门禁语义。
    assert.equal(step.if, "${{ !cancelled() && steps.setup.outcome == 'success' }}");
  }
  // 原始真值命令不是 CI 替代：它们对存量债务必然报错，跑在 CI 会让门禁恒红。
  const allRuns = jobs.checks.steps.map((step) => String(step.run ?? "")).join("\n");
  assert.doesNotMatch(allRuns, /^\s*pnpm (?:lint|fmt:check)\s*$/m);
});

test("build matrix ships only the nekcode product for Windows x64/arm64 and macOS arm64/x64", async () => {
  const jobs = await loadJobs();
  const desktop = jobs.build;
  const matrix = desktop.strategy.matrix;
  assert.deepEqual(
    matrix.target.map(({ platform, arch }) => `${platform}-${arch}`),
    ["win-x64", "win-arm64"],
  );
  // 发布只含正式产品：preview 身份不进 CI 矩阵（它不接收自动更新，放进 Release 只会让人选错）。
  assert.equal(matrix.flavor, undefined);
  assert.equal((await parse(await readFile(workflowPath, "utf8"))).env.ZCODE_ENV, "production");
  assert.equal(desktop.env?.ZCODE_ENV, undefined);
  assert.equal(desktop.env?.ZCODE_TARGET_OS, "${{ matrix.target.platform }}");
  assert.equal(desktop.env?.ZCODE_TARGET_ARCH, "${{ matrix.target.arch }}");
  assert.equal(desktop.env?.ZCODE_PREVIEW_IDENTITY, "0");
  assert.equal(desktop.strategy["fail-fast"], false);
  assert.ok(desktop.name.includes("matrix.target.platform"));
  const mac = jobs["build-macos"];
  assert.equal(mac.strategy["fail-fast"], false);
  assert.deepEqual(
    mac.strategy.matrix.target.map(({ arch }) => arch),
    ["arm64", "x64"],
  );
  assert.match(String(mac.if), /workflow_dispatch/);
  assert.match(String(mac.if), /inputs\.build_macos/);
  assert.equal(mac.strategy.matrix.flavor, undefined);
  assert.equal(mac.env?.ZCODE_PREVIEW_IDENTITY, "0");
});

test("actual event expressions expand to two Windows jobs, macOS only on opt-in dispatch", async () => {
  const jobs = await loadJobs();
  for (const [event, refType, buildMacos, expected] of [
    ["pull_request", "branch", false, 2],
    ["push", "branch", false, 2],
    ["push", "tag", false, 2],
    ["workflow_dispatch", "branch", false, 2],
    ["workflow_dispatch", "branch", true, 4],
    ["workflow_dispatch", "tag", true, 4],
  ]) {
    const context = {
      github: { event_name: event, ref_type: refType },
      inputs: { build_macos: buildMacos },
      needs: { "remote-assets": { result: "success" } },
      cancelled: () => false,
    };
    const combinations = [];
    for (const id of ["build", "build-macos"]) {
      const job = jobs[id];
      // Actions 允许 job id 含横杠；映射到 JS 的方括号属性语法再求值。
      const condition = String(job.if)
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replaceAll("needs.remote-assets", 'needs["remote-assets"]');
      const enabled = runInNewContext(condition, context, { timeout: 1000 });
      if (!enabled) continue;
      for (const target of job.strategy.matrix.target)
        combinations.push(`${target.platform ?? "mac"}/${target.arch}`);
    }
    assert.equal(combinations.length, expected, `${event}/${refType}`);
    assert.equal(new Set(combinations).size, expected);
    // 默认只打 Windows；macOS（10 倍计费）只在手动触发且显式勾选时打包。
    assert.equal(
      combinations.some((item) => item.startsWith("mac/")),
      buildMacos,
    );
  }
});

test("release downloads every platform/arch artifact into per-job directories", async () => {
  const jobs = await loadJobs();
  const release = jobs.release;
  const downloads = uses(release, "actions/download-artifact");
  // 4 个 artifact 各自落到 dist/artifacts/<name>/：同名 latest*.yml 不能平铺下载，
  // 否则后一个架构的更新元数据会静默覆盖前一个。
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].with?.pattern, "desktop-*");
  assert.equal(downloads[0].with?.path, "dist/artifacts");
  assert.equal(downloads[0].with?.["merge-multiple"], undefined);
  const runs = release.steps.map((step) => String(step.run ?? ""));
  const assemble = runs.findIndex((run) => run.includes("desktop-release.mjs assemble"));
  const publish = runs.findIndex((run) => run.includes("desktop-release.mjs publish"));
  assert.ok(assemble >= 0 && publish > assemble);
});

test("packaging jobs collect the platform update metadata required by electron-updater", async () => {
  const jobs = await loadJobs();
  for (const [id, platform] of [
    ["build", "$ZCODE_TARGET_OS"],
    ["build-macos", "mac"],
  ]) {
    const collect = jobs[id].steps.find((step) =>
      String(step.run ?? "").includes("desktop-release.mjs collect"),
    );
    assert.ok(collect, `${id} must collect installers and update metadata`);
    assert.ok(String(collect.run).includes(platform));
    // 上传的是 collect 之后的整个 release-assets 目录，包含 latest*.yml 与安装包。
    const upload = uses(jobs[id], "actions/upload-artifact")[0];
    assert.equal(upload.with?.path, "dist/release-assets/*");
    assert.equal(upload.with?.["if-no-files-found"], "error");
  }
  // update metadata 名字由发布脚本统一派生：latest.yml / latest-mac.yml（不发布 Linux 桌面包）。
  assert.deepEqual(releaseUpdateInfoNames([desktopProductIdentities.production]), [
    "latest-mac.yml",
    "latest.yml",
  ]);
});

test("release publishes only through gh with a scoped token", async () => {
  const document = parse(await readFile(workflowPath, "utf8"));
  const jobs = document.jobs;
  // 发布 job 之外的权限只有读；写权限只在发布 job 内。
  assert.equal(document.permissions?.contents, "read");
  assert.equal(jobs.release.permissions?.contents, "write");
  for (const id of Object.keys(jobs).filter((job) => job !== "release"))
    assert.notEqual(jobs[id].permissions?.contents, "write");
  const publishStep = jobs.release.steps.find((step) =>
    String(step.run ?? "").includes("desktop-release.mjs publish"),
  );
  assert.equal(publishStep.env?.GH_TOKEN, "${{ github.token }}");
  // electron-builder 自身禁止发布（--publish never 由 bundle:desktop 固定），
  // 也不使用 softprops/action-gh-release 之类的第三方发布 action。
  const allRuns = Object.values(jobs)
    .flatMap((job) => job.steps.map((step) => String(step.run ?? "")))
    .join("\n");
  assert.doesNotMatch(allRuns, /--publish\s+always/);
  assert.equal(uses(jobs.release, "softprops/action-gh-release").length, 0);
  // 更新源是 GitHub Releases，两个 owner/repo 变量都从当前仓库派生。
  assert.equal(document.env.NEKCODE_UPDATE_OWNER, "${{ github.repository_owner }}");
  assert.equal(document.env.NEKCODE_UPDATE_REPO, "${{ github.event.repository.name }}");
});

test("electron-builder publishes to the GitHub Releases provider", async () => {
  // provider 是构建配置的事实来源，工作流不重复声明；这里断言两者没有分叉。
  const root = resolve(import.meta.dirname, "../..");
  const config = await readFile(
    resolve(root, "packages/desktop/electron-builder.config.js"),
    "utf8",
  );
  assert.match(config, /provider:\s*"github"/);
  assert.match(config, /owner:\s*resolveGithubPublishOwner\(process\.env\)/);
  assert.match(config, /repo:\s*resolveGithubPublishRepo\(process\.env\)/);
  assert.match(config, /NEKCODE_DEEP_LINK_SCHEME/);
});

test("signing runs only when certificate secrets exist and says so when it cannot", async () => {
  const jobs = await loadJobs();
  const document = parse(await readFile(workflowPath, "utf8"));
  assert.equal(document.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  for (const id of ["build", "build-macos"]) {
    const step = jobs[id].steps.find((item) => item.name === "Resolve signing configuration");
    assert.ok(step, `${id} must resolve signing configuration from secrets`);
    for (const input of ["WINDOWS_CSC_LINK", "MACOS_CSC_LINK", "MACOS_SIGNING_IDENTITY"])
      assert.match(String(step.env?.[input]), new RegExp(`secrets\\.${input}`));
    // 缺 secret 时必须留明确提示，不能静默产出未签名包。
    assert.match(String(step.run), /::notice::未配置/);
    assert.match(String(step.run), /CSC_IDENTITY_AUTO_DISCOVERY=true/);
  }
  // macOS 证书签名仍需显式开关；没有证书时 electron-builder 配置走 ad-hoc 签名。
  const macStep = jobs["build-macos"].steps.find(
    (item) => item.name === "Resolve signing configuration",
  );
  assert.match(String(macStep.run), /ZCODE_ENABLE_MAC_SIGN=1/);
});

test("release still requires checks success before publishing", async () => {
  const jobs = await loadJobs();
  const release = jobs.release;
  // needs 列出全部必需 lane：静态门禁、四条测试车道（单个 matrix job）、浏览器冒烟、打包 job。
  // macOS 默认跳过，所以 if 条件显式允许 build-macos 为 skipped。
  assert.deepEqual(release.needs, ["checks", "tests", "browser-checks", "build", "build-macos"]);
  assert.match(release.if, /github\.event_name == 'push'/);
  assert.match(release.if, /github\.ref_type == 'tag'/);
  for (const id of ["checks", "tests", "browser-checks", "build"])
    assert.match(release.if, new RegExp(`needs\\.${id}\\.result == 'success'`), id);
  assert.match(release.if, /needs\.build-macos\.result == 'skipped'/);
  assert.equal(release["continue-on-error"], undefined);
});

test("release condition allows skipped macOS but never bypasses failed or cancelled required jobs", async () => {
  const { release } = await loadJobs();
  const expression = release.if
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/needs\.([\w-]+)/g, (_, id) => `needs[${JSON.stringify(id)}]`);
  const evaluate = (results = {}, event = "push", ref = "tag", cancelled = false) =>
    runInNewContext(
      expression,
      {
        github: { event_name: event, ref_type: ref },
        needs: Object.fromEntries(
          Object.entries({
            checks: "success",
            tests: "success",
            "browser-checks": "success",
            build: "success",
            "build-macos": "skipped",
            ...results,
          }).map(([id, result]) => [id, { result }]),
        ),
        cancelled: () => cancelled,
      },
      { timeout: 1000 },
    );
  assert.equal(evaluate(), true);
  assert.equal(evaluate({ "build-macos": "success" }), true);
  // 新增的测试/浏览器 lane 与原有门禁同等重要：任何失败或取消都不能 publish。
  for (const result of ["failure", "cancelled", "skipped"]) {
    for (const id of ["checks", "tests", "browser-checks", "build"])
      assert.equal(evaluate({ [id]: result }), false, `${id} ${result}`);
  }
  assert.equal(evaluate({ "build-macos": "failure" }), false);
  assert.equal(evaluate({ "build-macos": "cancelled" }), false);
  assert.equal(evaluate({}, "push", "branch"), false);
  assert.equal(evaluate({}, "workflow_dispatch"), false);
  assert.equal(evaluate({}, "push", "tag", true), false);
});

test("macOS packaging is opt-in so a Windows-only release does not pay for it", async () => {
  const jobs = await loadJobs();
  // 默认（tag push / main push / PR）都不跑 macOS：只有手动触发并勾选 build_macos 才打包。
  assert.doesNotMatch(jobs["build-macos"].if, /github\.ref_type == 'tag'/);
  assert.match(jobs["build-macos"].if, /github\.event_name == 'workflow_dispatch'/);
  assert.match(jobs["build-macos"].if, /inputs\.build_macos/);
  const workflow = await loadWorkflow();
  assert.equal(workflow.on.workflow_dispatch.inputs.build_macos.default, false);
});

// ===== 并行化与缓存接线（checks / tests / browser-checks 与下载缓存） =====
test("parallel lanes have no serial dependency on each other", async () => {
  const jobs = await loadJobs();
  // 静态门禁、测试车道、浏览器冒烟、远端资产都只依赖 checkout + setup-workspace，
  // 谁也不等谁：任一条慢 lane 不再拖住其它 job。
  for (const id of ["checks", "tests", "browser-checks", "remote-assets"])
    assert.equal(jobs[id].needs, undefined, `${id} must not wait for another job`);
  // 打包仍只等真实资产产出（与拆分前一致）。
  for (const id of ["build", "build-macos"]) assert.deepEqual(jobs[id].needs, "remote-assets");
  // 发布等全部必需 lane。
  assert.deepEqual(jobs.release.needs, [
    "checks",
    "tests",
    "browser-checks",
    "build",
    "build-macos",
  ]);
});

test("tests job splits into four independent lanes that all report results", async () => {
  const { tests } = await loadJobs();
  // fail-fast: false 才能在一次 run 里看到所有车道的真实结果，而不是第一条失败就取消其它。
  assert.equal(tests.strategy["fail-fast"], false);
  const lanes = tests.strategy.matrix.lane;
  assert.deepEqual(
    lanes.map((lane) => lane.id),
    ["ui", "services", "workspace", "scripts-ci"],
  );
  for (const lane of lanes) {
    assert.ok(String(lane.commands ?? "").trim().length > 0, `lane ${lane.id} has no commands`);
    assert.doesNotMatch(String(lane.commands), /continue-on-error|\|\|\s*true/u);
  }
  // 车道命令通过单个 step 执行，命令文本住在 matrix 里：不允许每条 lane 复制一份 step。
  const laneSteps = runSteps(tests).filter((step) => String(step.run).includes("matrix.lane"));
  assert.deepEqual(
    laneSteps.map((step) => String(step.run).trim()),
    ["${{ matrix.lane.commands }}"],
  );
  // 每个 step 仍然只在 setup 成功、未取消时执行：不引入 always()/success() 改写语义。
  for (const step of runSteps(tests)) assert.equal(step["continue-on-error"], undefined, step.name);
});

test("checks keeps only static gates and no longer runs suites or browsers", async () => {
  const { checks } = await loadJobs();
  const commands = runSteps(checks)
    .map((step) => String(step.run))
    .join("\n");
  for (const forbidden of [
    "vitest",
    "node --test",
    "node --import tsx --test",
    "playwright",
    "-smoke.mjs",
    "build:no-runtime-assets",
  ])
    assert.ok(!commands.includes(forbidden), `checks must not run ${forbidden}`);
  // 静态门禁本身一条都不能少。
  for (const command of [
    "node scripts/ci/desktop-release.mjs check-version",
    "pnpm typecheck",
    "pnpm gate:lint",
    "pnpm gate:format",
    "pnpm architecture:check",
    "pnpm gate:knip",
    "npx --yes @action-validator/cli",
  ])
    assert.ok(commands.includes(command), `checks missing ${command}`);
});

test("every original suite is still run exactly once after the split", async () => {
  const jobs = await loadJobs();
  const commands = allRuns(jobs);
  const count = (needle) => commands.split(needle).length - 1;
  for (const suite of [
    "pnpm vitest run --dir packages/client/src",
    "pnpm vitest run --dir packages/server/src",
    "pnpm vitest run --dir packages/desktop/src --exclude '**/ipcSignalFanout.test.ts'",
    "pnpm vitest run packages/desktop/scripts/build-metadata.test.ts scripts/rolling-app-version.test.ts",
    "pnpm --filter @zcode/ui exec vitest run src",
    "node --import tsx --test packages/services/test/*.test.ts",
    "node --test --test-isolation=none scripts/ci/*.test.mjs",
  ]) {
    assert.equal(count(suite), 1, `${suite} must run exactly once`);
  }
  // 曾经单跑、实际被完整 UI 套件覆盖的两条命令已收敛，不再重复跑一遍回归。
  // （覆盖校验 step 里出现的文件名不算命令，这里只看 vitest 的实际调用。）
  assert.doesNotMatch(commands, /vitest run --config packages\/ui\/vitest\.config\.ts/u);
});

test("full UI suite provably owns the collapsed pinpoint suites", async () => {
  const { tests } = await loadJobs();
  const uiLane = tests.strategy.matrix.lane.find((lane) => lane.id === "ui");
  assert.equal(String(uiLane.commands).trim(), "pnpm --filter @zcode/ui exec vitest run src");
  // CI 里有一条显式校验：用 vitest list 收集真实文件清单，断言两条定点套件都在其中。
  const proof = runSteps(tests).find((step) => String(step.name).includes("pinpoint suites"));
  assert.ok(proof, "missing UI suite coverage proof step");
  assert.equal(
    proof.if,
    "${{ !cancelled() && matrix.lane.id == 'ui' && steps.setup.outcome == 'success' }}",
  );
  for (const suite of [
    "src/v4/conversationTurnNavigatorPreview.test.ts",
    "src/v4/conversationTurnRenderUnits.test.ts",
  ])
    assert.ok(String(proof.run).includes(suite), `proof must check ${suite}`);
  assert.match(String(proof.run), /vitest list src/u);
  assert.match(String(proof.run), /exit 1/u);
  // 静态侧同样成立：两条套件确实在 packages/ui/src 下，且 UI vitest 配置没有把它们排除。
  const uiSources = await readdir(resolve(root, "packages/ui/src/v4"));
  for (const file of [
    "conversationTurnNavigatorPreview.test.ts",
    "conversationTurnRenderUnits.test.ts",
  ])
    assert.ok(uiSources.includes(file), `${file} must exist in packages/ui/src/v4`);
  const uiConfig = await readFile(resolve(root, "packages/ui/vitest.config.ts"), "utf8");
  assert.doesNotMatch(uiConfig, /\b(exclude|include)\s*:/u);
});

test("browser smokes stay serial in one job with a single build", async () => {
  const { "browser-checks": browser } = await loadJobs();
  assert.equal(browser.needs, undefined);
  assert.equal(browser.strategy, undefined, "browser smokes must not be split into a matrix");
  const commands = runSteps(browser)
    .map((step) => String(step.run))
    .join("\n");
  // 只在冒烟前构建一次（原先把 build 夹在两条冒烟之间，构建成本被重复摊在串行链上）。
  assert.equal(commands.split("build:no-runtime-assets").length - 1, 1);
  for (const smoke of [
    "remote-form-smoke.mjs",
    "conversation-navigator-smoke.mjs",
    "local-share-context-smoke.mjs",
    "session-local-errors-smoke.mjs",
    "local-onboarding-smoke.mjs",
    "no-official-purchase-smoke.mjs",
    "local-preferences-smoke.mjs",
    "root-startup-smoke.mjs",
    "conversation-export-smoke.mjs",
    "conversation-import-smoke.mjs",
  ])
    assert.equal(commands.split(smoke).length - 1, 1, `${smoke} must run once`);
  // 构建必须在全部冒烟之前，Playwright 安装在构建之前。
  const runs = runSteps(browser).map((step) => String(step.run));
  const install = runs.findIndex((command) => command.includes("playwright-core install"));
  const build = runs.findIndex((command) => command.includes("build:no-runtime-assets"));
  const firstSmoke = runs.findIndex((command) => command.includes("-smoke.mjs"));
  assert.ok(install >= 0 && build > install && firstSmoke > build);
});

test("no job hides a regression behind continue-on-error or success masking", async () => {
  const jobs = await loadJobs();
  for (const [id, job] of Object.entries(jobs)) {
    assert.equal(job["continue-on-error"], undefined, `${id} job must not continue on error`);
    for (const step of runSteps(job)) {
      assert.equal(step["continue-on-error"], undefined, `${id}: ${step.name}`);
      assert.doesNotMatch(String(step.run), /\|\|\s*true\s*$|;\s*exit 0\b/u, `${id}: ${step.name}`);
    }
  }
});

test("every job that runs tests or browsers installs dependencies first", async () => {
  const jobs = await loadJobs();
  for (const id of ["checks", "tests", "browser-checks", "remote-assets", "release"]) {
    const setup = jobs[id].steps.findIndex((step) =>
      String(step.uses ?? "").includes("./.github/actions/setup-workspace"),
    );
    assert.ok(setup >= 0, `${id} must setup the workspace`);
    // setup-workspace 默认安装依赖：缓存命中也不会退回“只恢复不安装”。
    assert.equal(jobs[id].steps[setup].with?.["install-dependencies"], undefined);
  }
});

test("workflow restores every download cache before use and saves it after", async () => {
  const jobs = await loadJobs();
  const expectations = [
    { job: "browser-checks", name: "playwright", consumer: "playwright-core install" },
    { job: "remote-assets", name: "remote-node", consumer: "pnpm prepare:remote-assets" },
    { job: "build", name: "electron", consumer: "pnpm bundle:desktop" },
    { job: "build", name: "electron-builder", consumer: "pnpm bundle:desktop" },
    { job: "build-macos", name: "electron", consumer: "pnpm bundle:desktop" },
    { job: "build-macos", name: "electron-builder", consumer: "pnpm bundle:desktop" },
  ];
  for (const { job: id, name, consumer } of expectations) {
    const job = jobs[id];
    const restores = job.steps.filter(
      (step) =>
        step.uses === "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9" &&
        step.with?.key === `\${{ steps.cache-keys.outputs.${name}-key }}`,
    );
    const saves = job.steps.filter(
      (step) =>
        step.uses === "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9" &&
        step.with?.key === `\${{ steps.cache-keys.outputs.${name}-key }}`,
    );
    assert.equal(restores.length, 1, `${id} must restore ${name} once`);
    assert.equal(saves.length, 1, `${id} must save ${name} once`);
    // 路径必须一致：restore 与 save 指向同一目录，否则缓存永远不命中。
    assert.equal(saves[0].with.path, restores[0].with.path, `${id} ${name} path mismatch`);
    // 顺序：恢复 -> 使用缓存的步骤 -> 写入（失败不写缓存，且绝不会 cache-hit 就跳过使用步骤）。
    const index = (predicate) => job.steps.findIndex(predicate);
    const restoreAt = index((step) => step === restores[0]);
    const saveAt = index((step) => step === saves[0]);
    const useAt = index((step) => String(step.run ?? "").includes(consumer));
    assert.ok(
      restoreAt < useAt && useAt < saveAt,
      `${id} ${name} order ${restoreAt}/${useAt}/${saveAt}`,
    );
    // PR 只恢复不写入；命中主键时也不必重复上传。
    const saveIf = String(saves[0].if);
    assert.match(saveIf, /github\.event_name != 'pull_request'/u);
    assert.match(saveIf, /cache-hit != 'true'/u);
    assert.match(saveIf, /!cancelled\(\)/u);
    assert.match(saveIf, /success\(\)/u);
    // 缓存命中同样执行安装与校验：除了 cache/save 自身（命中主键就不必再上传），
    // 没有任何 step 用 cache-hit 作为跳过条件。
    for (const step of job.steps) {
      if (String(step.uses ?? "").startsWith("actions/cache/save")) continue;
      assert.doesNotMatch(String(step.if ?? ""), /cache-hit/u, `${id}: ${step.name}`);
    }
  }
});

test("cached directories are download inputs only, never build output or credentials", async () => {
  const jobs = await loadJobs();
  const forbidden = [
    /node_modules/u,
    /(^|\/)dist(\/|$)/u,
    /bundled-/u,
    /release-assets/u,
    /\.ssh/u,
    /\.p12/u,
    /\.pfx/u,
    /CSC_/u,
  ];
  const cachedPaths = Object.values(jobs)
    .flatMap((job) => job.steps)
    .filter((step) => String(step.uses ?? "").startsWith("actions/cache/"))
    .map((step) => String(step.with?.path ?? ""));
  assert.ok(cachedPaths.length >= 6, "expected the download caches to be wired");
  for (const path of cachedPaths)
    for (const pattern of forbidden)
      assert.doesNotMatch(path, pattern, `cache path must not hold ${pattern}: ${path}`);
  // Playwright 目录由 PLAYWRIGHT_BROWSERS_PATH 显式指定，缓存路径与安装目标同源。
  assert.equal(
    jobs["browser-checks"].env.PLAYWRIGHT_BROWSERS_PATH,
    "${{ github.workspace }}/.cache/ms-playwright",
  );
  // electron-builder 打包时读写的目录就是被缓存的目录（同一个 helper output）。
  for (const id of ["build", "build-macos"]) {
    const pack = jobs[id].steps.find((step) =>
      String(step.run ?? "").includes("pnpm bundle:desktop"),
    );
    assert.equal(
      pack.env.ELECTRON_BUILDER_CACHE,
      "${{ steps.cache-keys.outputs.electron-builder-dir }}",
    );
  }
});

test("dependency install still runs on a store cache hit", async () => {
  const action = parse(await readFile(setupActionPath, "utf8"));
  const install = action.runs.steps.find((step) => step.name === "Install dependencies");
  assert.ok(install, "setup-workspace must install dependencies");
  assert.equal(install.run, "pnpm install --frozen-lockfile --prefer-offline");
  // 安装步骤只由输入控制，不看缓存命中状态。
  assert.equal(install.if, "inputs.install-dependencies == 'true'");
  assert.equal(install["continue-on-error"], undefined);
  const setupNode = action.runs.steps.find((step) =>
    String(step.uses).startsWith("actions/setup-node"),
  );
  // pnpm store 缓存仍由 setup-node 自己管理 lockfile 指纹。
  assert.equal(
    setupNode.with.cache,
    "${{ inputs.install-dependencies == 'true' && 'pnpm' || '' }}",
  );
  assert.equal(setupNode.with["cache-dependency-path"], "pnpm-lock.yaml");
  // setup-node/pnpm 仍钉在完整 SHA 上。
  for (const step of action.runs.steps)
    if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/u, step.uses);
});

test("every third-party action in the desktop workflow is pinned to a commit", async () => {
  const jobs = await loadJobs();
  for (const [id, job] of Object.entries(jobs))
    for (const step of job.steps) {
      const uses = String(step.uses ?? "");
      if (!uses || uses.startsWith("./")) continue;
      assert.match(uses, /@[0-9a-f]{40}$/u, `${id}: ${uses}`);
    }
});
