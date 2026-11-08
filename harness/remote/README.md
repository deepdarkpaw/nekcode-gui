# harness/remote

本地与 CI 用的 SSH 远端测试镜像：Ubuntu 22.04 + openssh-server，带 root/dev 弱口令。
**只用于测试**，不要发布到任何 registry，也不要当真实主机使用。

## 构建

```bash
bash harness/remote/build.sh                 # 等价于 docker buildx build --load -t nekcode-remote-harness:local .
bash harness/remote/build.sh my-tag:dev      # 自定义镜像名
NEKCODE_REMOTE_HARNESS_CACHE_DIR=.tmp/buildkit-cache bash harness/remote/build.sh  # 复用本地层缓存
```

脚本只在 `harness/remote` 目录里构建（`cd "$(dirname "$0")"`），不读取 `~/.ssh` 下的任何密钥，
也不 push 镜像。`--load` 把结果放进本地 docker 镜像库，供下面的 `docker run` 使用。

## 运行

```bash
docker run -d --rm -p 127.0.0.1:2222:22 --name nekcode-remote-harness nekcode-remote-harness:local
ssh -p 2222 root@127.0.0.1     # 口令 root；普通用户 dev/dev
docker rm -f nekcode-remote-harness
```

端口只绑 `127.0.0.1`：镜像里的弱口令不能出现在公网可达的地址上。

## CI

`.github/workflows/remote-harness.yml` 只在 `harness/remote/**`（或该工作流自身）变更时触发，
也可以手动 `workflow_dispatch`：

1. `docker/setup-buildx-action` + `docker/build-push-action` 用 BuildKit 构建同一个 Dockerfile，
   `cache-from`/`cache-to` 都是 `type=gha` 且共用同一个 scope，`load: true`、从不 push。
2. 启动容器后生成一次性 ed25519 密钥，`docker exec` 注入 `authorized_keys`，
   用 `ssh` 执行 `id -un` 断言 sshd 真的能登录；端口通过 `docker port` 取得并只绑 `127.0.0.1`。
3. 同一步的 `trap` 负责删除容器与临时密钥，失败也会清理。

层缓存命中只是省下载与 apt 安装；缓存缺失或损坏时构建照常从零执行，失败会如实让 job 变红。
镜像本身不参与桌面打包和发布：桌面产物与远端运行时都不经过 Docker。
