#!/usr/bin/env bash
# 服务器部署:使用本地构建并传输过来的镜像(不在本机构建,不连 GitHub)
# 由本地 deploy/publish.sh 调用:bash deploy/deploy-images.sh <VERSION>
# 流程:记录版本 → 从 prod-bare 拉代码(取迁移文件)→ 备份 → 迁移 →
#       存档旧镜像 → 应用新镜像 → 重启 → 健康检查 → 输出回滚指引
set -euo pipefail

VERSION="${1:?用法: deploy-images.sh <镜像版本号,如 20261125-143000-17c4455>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
COMPOSE=(docker compose --env-file deploy/.env -f compose.production.yaml)
SERVICES=(api web initialize)
KEEP_BACKUPS=10
KEEP_ROLLBACKS=3
HEALTH_TIMEOUT=180

step() { printf '\n\033[1;36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
fail()  { printf '\033[1;31m失败: %s\033[0m\n' "$*" >&2; exit 1; }

mysql_exec() { local sql="$1"; "${COMPOSE[@]}" exec -T mysql sh -c "MYSQL_PWD=\$MYSQL_PASSWORD mysql -N -ulive live_training" <<<"$sql"; }

step "1/7 记录当前版本"
PREV_COMMIT="$(git rev-parse HEAD)"
echo "  当前: $PREV_COMMIT"

step "2/7 拉取最新代码(镜像仓库 prod-bare,不经过 GitHub)"
if ! git pull --ff-only prod-bare main; then fail "git pull 失败(本地有改动或非快进更新),请人工处理"; fi
NEW_COMMIT="$(git rev-parse HEAD)"
echo "  更新: $NEW_COMMIT"
[ "$PREV_COMMIT" = "$NEW_COMMIT" ] && echo "  代码无变化,继续应用镜像"

step "3/7 备份数据库"
mkdir -p backups
BACKUP="backups/pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz"
"${COMPOSE[@]}" exec -T mysql sh -c "MYSQL_PWD=\$MYSQL_PASSWORD mysqldump -ulive --single-transaction --no-tablespaces live_training" | gzip > "$BACKUP"
[ -s "$BACKUP" ] || fail "备份文件为空,中止发布"
echo "  备份: $BACKUP ($(du -h "$BACKUP" | cut -f1))"
ls -t backups/pre-deploy-*.sql.gz 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm --

step "4/7 应用数据库迁移"
mysql_exec "CREATE TABLE IF NOT EXISTS \`_migrations\` (\`name\` VARCHAR(191) PRIMARY KEY, \`applied_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);"
shopt -s nullglob
for f in deploy/migrations/*.sql; do
  case "$f" in *.down.sql) continue;; esac
  name="$(basename "$f")"
  applied="$(mysql_exec "SELECT COUNT(*) FROM _migrations WHERE name='$name'")"
  if [ "${applied// /}" = "1" ]; then
    echo "  跳过已应用: $name"
  else
    echo "  应用迁移: $name"
    mysql_exec "$(cat "$f")"
    mysql_exec "INSERT INTO _migrations(name) VALUES ('$name')"
  fi
done
shopt -u nullglob

step "5/7 存档旧镜像并应用新镜像 $VERSION"
ROLLBACK_TAG="rollback-$(date +%Y%m%d-%H%M%S)"
for svc in "${SERVICES[@]}"; do
  # 期望的新版本镜像必须已通过 docker load 到达本机
  docker image inspect "live-training-$svc:$VERSION" > /dev/null 2>&1 || fail "live-training-$svc:$VERSION 不存在,请先运行本地 deploy/publish.sh 完成传输"
  # 存档当前 latest(供快速回滚),保留最近 KEEP_ROLLBACKS 份
  if docker image inspect "live-training-$svc:latest" > /dev/null 2>&1; then
    docker tag "live-training-$svc:latest" "live-training-$svc:$ROLLBACK_TAG"
  fi
  docker tag "live-training-$svc:$VERSION" "live-training-$svc:latest"
  # 清理过多历史版本镜像(保留 latest、rollback* 与刚部署的 $VERSION);awk 全过滤时返回 0,避免 grep 无匹配返回 1 触发 set -e 退出
  docker images "live-training-$svc" --format '{{.Tag}}' | awk -v ver="$VERSION" '$0 != "latest" && $0 !~ /^rollback/ && $0 != ver' | sort -r | tail -n +"$((KEEP_ROLLBACKS + 1))" \
    | while read -r tag; do docker image rm "live-training-$svc:$tag" > /dev/null 2>&1 || true; done
done

step "6/7 重启服务(使用已加载镜像,不构建)"
"${COMPOSE[@]}" up -d

step "7/7 健康检查(最长等待 ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  api_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' live-training-api-1 2>/dev/null || echo none)"
  web_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' live-training-web-1 2>/dev/null || echo none)"
  if [ "$api_status" = "healthy" ] && [ "$web_status" = "healthy" ]; then
    echo "  api: healthy / web: healthy"
    docker image prune -f > /dev/null 2>&1 || true
    "${COMPOSE[@]}" rm -sf initialize > /dev/null 2>&1 || true
    docker image rm live-training-initialize:latest > /dev/null 2>&1 || true
    printf '\n\033[1;32m发布成功\033[0m %s -> %s(镜像 %s)\n' "$PREV_COMMIT" "$NEW_COMMIT" "$VERSION"
    exit 0
  fi
  sleep 5
done

printf '\n\033[1;31m健康检查超时(api:%s web:%s),按以下步骤回滚:\033[0m
  1) 快速回滚镜像:for s in api web initialize; do docker tag live-training-$s:%s live-training-$s:latest; done
     然后 docker compose --env-file deploy/.env -f compose.production.yaml up -d 并观察 docker ps 健康状态
  2) 代码回滚:git reset --hard %s
  3) 如需回滚数据库结构:手动执行 deploy/migrations/*.down.sql(慎用)
  4) 如需恢复数据:zcat %s | docker exec -i live-training-mysql-1 sh -c "MYSQL_PWD=\\$MYSQL_PASSWORD mysql -ulive live_training"
' "$api_status" "$web_status" "$ROLLBACK_TAG" "$PREV_COMMIT" "$BACKUP" >&2
exit 1
