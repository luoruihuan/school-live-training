#!/usr/bin/env bash
# 一键发布脚本（在生产服务器 /srv/live-training 上执行）
# 用法：ssh tokyo 'bash /srv/live-training/deploy/deploy.sh'
# 流程：记录版本 -> 拉取代码 -> 备份数据库 -> 应用迁移 -> 构建镜像 -> 重启 -> 健康检查 -> 输出回滚指引
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
COMPOSE=(docker compose --env-file deploy/.env -f compose.production.yaml)
KEEP_BACKUPS=10
HEALTH_TIMEOUT=180

step() { printf '\n\033[1;36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
fail()  { printf '\033[1;31m失败: %s\033[0m\n' "$*" >&2; exit 1; }

mysql_exec() { local sql="$1"; "${COMPOSE[@]}" exec -T mysql sh -c "MYSQL_PWD=\$MYSQL_PASSWORD mysql -N -ulive live_training" <<<"$sql"; }

step "1/7 记录当前版本"
PREV_COMMIT="$(git rev-parse HEAD)"
echo "  当前: $PREV_COMMIT"

step "2/7 拉取最新代码"
if ! git pull --ff-only origin main; then fail "git pull 失败（本地有改动或非快进更新），请人工处理"; fi
# 脚本自身有更新时，重新加载新版脚本继续执行，避免半新半旧
if ! git diff --quiet "$PREV_COMMIT" HEAD -- deploy/deploy.sh; then
  echo "  deploy.sh 已更新，重新加载新版脚本"
  exec bash "$REPO_ROOT/deploy/deploy.sh"
fi
NEW_COMMIT="$(git rev-parse HEAD)"
echo "  更新: $NEW_COMMIT"
if [ "$PREV_COMMIT" = "$NEW_COMMIT" ]; then echo "  代码无变化，继续执行构建与迁移检查"; fi

step "3/7 备份数据库"
mkdir -p backups
BACKUP="backups/pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz"
"${COMPOSE[@]}" exec -T mysql sh -c "MYSQL_PWD=\$MYSQL_PASSWORD mysqldump -ulive --single-transaction --no-tablespaces live_training" | gzip > "$BACKUP"
[ -s "$BACKUP" ] || fail "备份文件为空，中止发布"
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

step "5/7 构建镜像"
"${COMPOSE[@]}" build api web initialize

step "6/7 重启服务"
"${COMPOSE[@]}" up -d

step "7/7 健康检查（最长等待 ${HEALTH_TIMEOUT}s）"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  api_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' live-training-api-1 2>/dev/null || echo none)"
  web_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' live-training-web-1 2>/dev/null || echo none)"
  if [ "$api_status" = "healthy" ] && [ "$web_status" = "healthy" ]; then
    echo "  api: healthy / web: healthy"
    # 构建缓存保留 8G（磁盘宽裕时加速发布；仅超出部分清理最旧缓存，防止无上限增长。
    # 回放长期层已在 COS，本地盘压力解除；如磁盘再度紧张可调低此值）
    # 注：build 刚结束时 BuildKit 缓存引用可能尚未释放，立即 prune 会空转，故延迟 3 分钟后台执行，
    # 结果落盘 /root/deploy-prune.log 便于事后核对。
    ( sleep 180 && docker builder prune -af --keep-storage 8g && printf '[%s] builder prune done\n' "$(date '+%F %T')" ) >> "$HOME/deploy-prune.log" 2>&1 &
    docker image prune -f > /dev/null 2>&1 || true
    "${COMPOSE[@]}" rm -sf initialize > /dev/null 2>&1 || true
    docker image rm live-training-initialize:latest > /dev/null 2>&1 || true
    printf '\n\033[1;32m发布成功\033[0m %s -> %s（已清理构建缓存与初始化镜像）\n' "$PREV_COMMIT" "$NEW_COMMIT"
    exit 0
  fi
  sleep 5
done

printf '\n\033[1;31m健康检查超时（api:%s web:%s），按以下步骤回滚：\033[0m
  1) git reset --hard %s && git clean -fd
  2) bash deploy/deploy.sh            # 用旧代码重新构建并重启
  3) 如需回滚数据库结构：手动执行 deploy/migrations/*.down.sql（慎用）
  4) 如需恢复数据：zcat %s | docker exec -i live-training-mysql-1 sh -c "MYSQL_PWD=\\$MYSQL_PASSWORD mysql -ulive live_training"
' "$api_status" "$web_status" "$PREV_COMMIT" "$BACKUP" >&2
exit 1
