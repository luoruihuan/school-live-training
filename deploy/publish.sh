#!/usr/bin/env bash
# 本地发布:构建镜像 → SSH 传输 → 触发服务器部署(不在服务器上构建)
# 用法:bash deploy/publish.sh
# 前提:本地 Docker 已启动、ssh 可连接 server、代码已提交
# 流程:版本号 → push 代码(origin 容错 + prod 镜像仓库)→ 本地构建三镜像 →
#       docker save 传输 → 远端执行 deploy/deploy-images.sh(备份→迁移→up→健康检查)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
SSH_HOST="${SSH_HOST:-server}"
SERVICES=(api web initialize)

step() { printf '\n\033[1;36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '\033[1;31m失败: %s\033[0m\n' "$*" >&2; exit 1; }

[ -z "$(git status --porcelain)" ] || fail "工作区不干净,请先提交或暂存(git stash)"
git fetch origin main --quiet 2>/dev/null || true
[ -z "$(git log --oneline origin/main..HEAD 2>/dev/null)" ] || echo "  提示:本地领先 origin/main,先确认已推送 GitHub"

VERSION="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
step "1/5 版本 $VERSION(当前 $(git rev-parse --short HEAD))"

step "2/5 推送代码"
if git push origin main 2>/dev/null; then echo "  origin/main 已更新"; else echo "  origin 推送失败(GitHub 网络问题?),继续走 prod 镜像仓库"; fi
git push prod main || fail "推送 prod 镜像仓库失败(服务器代码源不可用)"

step "3/5 本地构建镜像(linux/amd64)"
for svc in "${SERVICES[@]}"; do
  printf '  building live-training-%s:%s…\n' "$svc" "$VERSION"
  docker build --platform linux/amd64 --target "$svc" -t "live-training-$svc:$VERSION" . \
    || fail "构建 live-training-$svc 失败"
done

step "4/5 传输镜像到 $SSH_HOST(压缩流,体积较大需数分钟)"
SAVE_IMAGES=()
for svc in "${SERVICES[@]}"; do SAVE_IMAGES+=("live-training-$svc:$VERSION"); done
docker save "${SAVE_IMAGES[@]}" | gzip | ssh "$SSH_HOST" docker load || fail "镜像传输失败"

step "5/5 触发服务器部署"
ssh "$SSH_HOST" "bash /srv/live-training/deploy/deploy-images.sh '$VERSION'" || fail "服务器部署失败(按远端输出的回滚指引处理)"

printf '\n\033[1;32m发布完成\033[0m 版本 %s\n' "$VERSION"
