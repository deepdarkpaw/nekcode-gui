#!/bin/bash
# 构建本地测试用 SSH 镜像（harness/remote/Dockerfile）。
# 只在 repo 的这个目录里构建，不读取任何用户 SSH 密钥，也不 push 到任何 registry。
set -euo pipefail

cd "$(dirname "$0")"

image="nekcode-remote-harness:local"
if [ "$#" -gt 0 ] && [ -n "$1" ]; then
  image="$1"
fi

# 可选本地层缓存：设置后同一台机器重复构建会复用 BuildKit 层，不设置就纯冷构建。
cache_args=()
if [ -n "${NEKCODE_REMOTE_HARNESS_CACHE_DIR:-}" ]; then
  cache_args=(
    --cache-from "type=local,src=$NEKCODE_REMOTE_HARNESS_CACHE_DIR"
    --cache-to "type=local,dest=$NEKCODE_REMOTE_HARNESS_CACHE_DIR,mode=max"
  )
fi

# buildx + --load：镜像构建后进入本地 docker 镜像库，供 docker run 使用；
# 不走 --push，测试镜像不发布。CI 用同一个 Dockerfile，但缓存换成 type=gha。
docker buildx build \
  --load \
  --tag "$image" \
  "${cache_args[@]}" \
  .
