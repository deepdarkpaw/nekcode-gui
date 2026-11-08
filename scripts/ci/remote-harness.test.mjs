import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// harness/remote 是仓库里唯一真实存在的 Docker 镜像：只给远程 SSH 测试用。
// 这里断言工作流结构、Dockerfile 层与 build.sh 的边界（不 push、不读用户密钥、
// 层缓存 scope 对称、容器验证后清理）。真实镜像构建与 GHA 层缓存由 Linux CI 执行：
// 本机没有 Docker，因此只证明结构与参数，不声称镜像已在本机构建过。
// YAML 的 schema 合法性由 checks job 里的 @action-validator/cli 覆盖全部 .github/workflows/*.yml。
const root = resolve(import.meta.dirname, "../..");
const workflowPath = resolve(root, ".github/workflows/remote-harness.yml");
const desktopWorkflowPath = resolve(root, ".github/workflows/desktop.yml");
const dockerfilePath = resolve(root, "harness/remote/Dockerfile");
const buildScriptPath = resolve(root, "harness/remote/build.sh");
const readmePath = resolve(root, "harness/remote/README.md");

const readAll = () =>
  Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(dockerfilePath, "utf8"),
    readFile(buildScriptPath, "utf8"),
    readFile(readmePath, "utf8"),
  ]);

/** 取 YAML 里某个顶层块的文本（到下一个同级 key 为止），用于按区块断言而不是全文匹配。 */
function block(text, header) {
  const start = text.indexOf(header);
  assert.ok(start >= 0, `missing block ${header}`);
  const rest = text.slice(start + header.length);
  const nextTopLevel = rest.search(/^[a-z]/mu);
  return nextTopLevel < 0 ? rest : rest.slice(0, nextTopLevel);
}

test("harness workflow is path-filtered, manual, and read-only", async () => {
  const [workflow] = await readAll();
  const triggers = block(workflow, "on:");
  for (const expected of [
    "pull_request:",
    "push:",
    "branches: [main]",
    "workflow_dispatch:",
    "- harness/remote/**",
    "- .github/workflows/remote-harness.yml",
  ])
    assert.ok(triggers.includes(expected), `trigger must include ${expected}`);
  // 路径过滤出现两次（pull_request 与 push 各一份），桌面发布不会触发这个工作流。
  assert.equal(triggers.split("- harness/remote/**").length - 1, 2);
  // 只读权限、没有任何 secret：测试镜像永远不发布。
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.doesNotMatch(workflow, /secrets\./u);
  assert.doesNotMatch(workflow, /contents: write/u);
  // 只有一个 job，且仍是 ubuntu runner（Docker 在 GitHub 托管 runner 上现成可用）。
  assert.equal(workflow.split(/^  image:/mu).length - 1, 1);
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
});

test("checks job schema-validates every workflow including the harness one", async () => {
  const desktopWorkflow = await readFile(desktopWorkflowPath, "utf8");
  // action-validator 覆盖 .github/workflows/*.yml：新增工作流不会被漏检。
  assert.match(desktopWorkflow, /for workflow in \.github\/workflows\/\*\.yml; do/u);
  assert.match(desktopWorkflow, /npx --yes @action-validator\/cli "\$workflow"/u);
});

test("buildkit layer cache uses one symmetric scope and never pushes", async () => {
  const [workflow] = await readAll();
  const buildx = /uses: (docker\/setup-buildx-action@[0-9a-f]{40}) # v(\d+)/u.exec(workflow);
  const build = /uses: (docker\/build-push-action@[0-9a-f]{40}) # v(\d+)/u.exec(workflow);
  // 官方 Docker action，钉在完整提交上，并在注释里写明 major 版本。
  assert.ok(buildx, "docker/setup-buildx-action must be pinned with a version comment");
  assert.ok(build, "docker/build-push-action must be pinned with a version comment");
  assert.ok(Number(buildx[2]) >= 3);
  assert.ok(Number(build[2]) >= 6);
  // 只 load 到本地给验证步骤用，绝不推送；显式写 false 而不是省略。
  assert.match(workflow, /^          load: true$/mu);
  assert.match(workflow, /^          push: false$/mu);
  assert.doesNotMatch(workflow, /push:\s*true/u);
  assert.doesNotMatch(workflow, /--push\b/u);
  assert.match(workflow, /^          context: harness\/remote$/mu);
  assert.match(workflow, /^          file: harness\/remote\/Dockerfile$/mu);
  // cache-from / cache-to 引用同一个 scope 变量；scope 名只在一处定义。
  const scope = "\\$\\{\\{ env\\.NEKCODE_REMOTE_HARNESS_CACHE_SCOPE \\}\\}";
  assert.match(workflow, new RegExp(`^          cache-from: type=gha,scope=${scope}$`, "mu"));
  assert.match(
    workflow,
    new RegExp(`^          cache-to: type=gha,scope=${scope},mode=max$`, "mu"),
  );
  assert.equal(
    workflow.split("NEKCODE_REMOTE_HARNESS_CACHE_SCOPE:").length - 1,
    1,
    "scope name must be defined exactly once",
  );
  // 缓存只省层构建：构建 step 不以 cache-hit 跳过，也没有 continue-on-error 兜底。
  assert.doesNotMatch(workflow, /cache-hit/u);
  assert.doesNotMatch(workflow, /continue-on-error/u);
  assert.doesNotMatch(workflow, /type=registry|type=local/u);
});

test("harness health check runs the real container, proves sshd and always cleans up", async () => {
  const [workflow] = await readAll();
  const run = block(workflow, "      - name: Verify container sshd end to end\n        run: |\n");
  // 端口只绑 127.0.0.1，宿主端口由 docker 随机分配后从 docker port 读取。
  assert.match(run, /-p 127\.0\.0\.1:0:22/u);
  assert.match(run, /docker port "\$name" 22\/tcp/u);
  // 一次性密钥登录验证 sshd 真的可用；镜像本身不得自带 authorized_keys。
  assert.match(run, /ssh-keygen -t ed25519 -N '' -q -f "\$key"/u);
  assert.match(run, /test ! -e \/root\/\.ssh\/authorized_keys/u);
  assert.match(run, /root@127\.0\.0\.1 'id -un'/u);
  // 口令登录策略仍按镜像约定存在（root/dev 弱口令只用于测试）。
  assert.match(run, /grep -qx "PermitRootLogin yes"/u);
  assert.match(run, /grep -qx "PasswordAuthentication yes"/u);
  // 失败也要清理：trap 删除容器与临时密钥，脚本本身在任一命令失败时退出。
  assert.match(run, /set -euo pipefail/u);
  assert.match(run, /trap cleanup EXIT/u);
  assert.match(run, /docker rm -f "\$name"/u);
  assert.match(run, /rm -f "\$key"/u);
  // 等待窗口有上限，超时按失败处理而不是静默通过。
  assert.match(run, /seq 1 30/u);
});

test("Dockerfile keeps a stable apt layer and the test sshd behaviour", async () => {
  const [, dockerfile] = await readAll();
  // 基础镜像固定在明确的 tag 上，不随 latest 漂移。
  assert.match(dockerfile, /^FROM ubuntu:22\.04$/mu);
  assert.doesNotMatch(dockerfile, /:latest|FROM .*@/u);
  // apt 只安装一次、单层完成、不装推荐包、装完清索引：稳定层才能被 BuildKit 复用。
  const aptBlocks = dockerfile.split(/\n\s*\n/u).filter((part) => part.includes("apt-get install"));
  assert.equal(aptBlocks.length, 1, "apt install must live in exactly one layer");
  assert.equal(aptBlocks[0].split("apt-get install").length - 1, 1);
  assert.match(aptBlocks[0], /apt-get update/u);
  assert.match(aptBlocks[0], /--no-install-recommends/u);
  assert.match(aptBlocks[0], /rm -rf \/var\/lib\/apt\/lists\/\*/u);
  assert.match(aptBlocks[0], /DEBIAN_FRONTEND=noninteractive/u);
  assert.equal(dockerfile.split("apt-get update").length - 1, 1);
  assert.doesNotMatch(dockerfile, /apt-get upgrade|dist-upgrade/u);
  // 缓存友好的顺序：apt 层在口令/用户配置之前，后者变化不会让 apt 重新执行。
  const aptIndex = dockerfile.indexOf("apt-get install");
  for (const later of ["PermitRootLogin yes", "useradd -m -s /bin/bash dev", "pam_loginuid"])
    assert.ok(dockerfile.indexOf(later) > aptIndex, `${later} must come after the apt layer`);
  // 测试镜像的行为保持不变：root/dev 弱口令、口令登录、sshd -D、EXPOSE 22。
  for (const behaviour of [
    /PermitRootLogin yes/u,
    /PasswordAuthentication yes/u,
    /root:root/u,
    /useradd -m -s \/bin\/bash dev/u,
    /dev:dev/u,
    /session optional pam_loginuid\.so/u,
    /^EXPOSE 22$/mu,
    /CMD \["\/usr\/sbin\/sshd", "-D"\]/u,
  ])
    assert.match(dockerfile, behaviour);
  // 不引入任何凭据注入通道：没有 build-arg/secret/authorized_keys，也不下载远端脚本。
  assert.doesNotMatch(dockerfile, /^ARG /mu);
  assert.doesNotMatch(dockerfile, /authorized_keys|ssh-rsa|ssh-ed25519/iu);
  assert.doesNotMatch(dockerfile, /curl|wget/u);
});

test("build.sh builds with buildx --load, optional local cache, and no user SSH keys", async () => {
  const [, , buildScript] = await readAll();
  assert.match(buildScript, /set -euo pipefail/u);
  // cwd 锚定脚本目录：从仓库根调用也能找到 Dockerfile 与构建上下文。
  assert.match(buildScript, /^cd "\$\(dirname "\$0"\)"$/mu);
  assert.match(buildScript, /docker buildx build/u);
  assert.match(buildScript, /^  --load \\$/mu);
  assert.match(buildScript, /--tag "\$image"/u);
  // 镜像名可覆盖但默认是本地测试镜像；从不 push（注释里提到 --push 不算）。
  assert.match(buildScript, /nekcode-remote-harness:local/u);
  assert.doesNotMatch(buildScript, /^\s*--push\b/mu);
  // 不再传 Dockerfile 未使用的 SSH_PUBLIC_KEY，也不读取用户 ~/.ssh。
  assert.doesNotMatch(buildScript, /SSH_PUBLIC_KEY|\.ssh|ssh-copy-id/u);
  // 可选本地层缓存：src/dest 来自同一个环境变量，两侧不会写歪。
  assert.match(buildScript, /NEKCODE_REMOTE_HARNESS_CACHE_DIR/u);
  assert.match(buildScript, /--cache-from "type=local,src=\$NEKCODE_REMOTE_HARNESS_CACHE_DIR"/u);
  assert.match(
    buildScript,
    /--cache-to "type=local,dest=\$NEKCODE_REMOTE_HARNESS_CACHE_DIR,mode=max"/u,
  );
});

test("harness docs describe the local-only test image and its limits", async () => {
  const [, , , readme] = await readAll();
  for (const topic of [
    "build.sh",
    "NEKCODE_REMOTE_HARNESS_CACHE_DIR",
    "127.0.0.1",
    "remote-harness.yml",
    "type=gha",
    "不要发布",
  ])
    assert.ok(readme.includes(topic), `README must document ${topic}`);
  // 文档不能再教用户把公钥拷进镜像（那是持久化测试凭据的做法）。
  assert.doesNotMatch(readme, /ssh-copy-id/u);
});
