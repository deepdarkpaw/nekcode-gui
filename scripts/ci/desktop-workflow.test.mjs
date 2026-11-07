import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { releaseUpdateInfoNames } from "./desktop-release.mjs";
import { desktopProductIdentities } from "../../packages/desktop/scripts/desktop-product-identity.mjs";

// 直接解析真实工作流（公开入口），断言 job 条件与 needs 图语义，
// 而不是复制一份手写函数；工作流文件是唯一事实来源。
const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/desktop.yml");

async function loadJobs() {
  const document = parse(await readFile(workflowPath, "utf8"));
  return document.jobs;
}

async function loadWorkflow() {
  return parse(await readFile(workflowPath, "utf8"));
}

const uses = (job, prefix) =>
  job.steps.filter((step) => String(step.uses ?? "").startsWith(prefix));

test("desktop workflow is valid YAML with the expected jobs", async () => {
  const jobs = await loadJobs();
  assert.deepEqual(Object.keys(jobs).sort(), [
    "build",
    "build-macos",
    "checks",
    "release",
    "remote-assets",
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
  const commands = jobs.checks.steps.map((step) => step.run ?? "").join("\n");
  for (const command of [
    "pnpm typecheck",
    "pnpm gate:lint",
    "pnpm gate:format",
    "pnpm gate:knip",
    "pnpm architecture:check",
    "pnpm vitest run",
    "node --test --test-isolation=none scripts/ci/*.test.mjs",
    "node scripts/ci/remote-form-smoke.mjs",
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
    const commands = job.steps.map((step) => step.run ?? "");
    const verify = commands.indexOf("node scripts/bundle-remote-assets.mjs verify");
    const prepare = commands.indexOf("pnpm prepare:desktop-runtime");
    const build = commands.indexOf("pnpm build:bootstrap");
    assert.ok(verify >= 0 && prepare > verify && build > prepare);
    assert.ok(commands.some((command) => command.includes("--skip-prepare --skip-build")));
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
  // needs 仍列出全部打包 job；macOS 默认跳过，所以 if 条件显式允许 build-macos 为 skipped。
  assert.deepEqual(release.needs, ["checks", "build", "build-macos"]);
  assert.match(release.if, /github\.event_name == 'push'/);
  assert.match(release.if, /github\.ref_type == 'tag'/);
  assert.match(release.if, /needs\.checks\.result == 'success'/);
  assert.match(release.if, /needs\.build\.result == 'success'/);
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
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.equal(evaluate({ checks: result }), false);
    assert.equal(evaluate({ build: result }), false);
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
