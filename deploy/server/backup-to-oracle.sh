#!/bin/bash
# 每日备份(root crontab 03:15)→ 甲骨文对象存储桶 live-recordings
# 架构定位:回放正本在腾讯 COS 不做副本;本脚本负责数据库+商品图的异地(异厂商)备份。
# 1) MySQL dump → 本地 backups/db/(保留14份)→ oracle backup/mysql/(按时间戳保留14天)
# 2) MinIO product-images copy-only(商品图正本在服务器 MinIO)
# 失败项自动飞书告警(FEISHU_WEBHOOK_URL 取自 deploy/.env)
exec 9>/tmp/backup-to-oracle.lock
flock -n 9 || exit 0

LOG=/srv/live-training/backups/backup-to-oracle.log
PROJECT=/srv/live-training
FEISHU_WEBHOOK="$(grep -E "^FEISHU_WEBHOOK_URL=" "$PROJECT/deploy/.env" | cut -d= -f2-)"
FAILED=""

alert() {
  [ -n "$FEISHU_WEBHOOK" ] || return 0
  curl -s -m 10 -H "Content-Type: application/json" \
    -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"[backup fail] tokyo backup-to-oracle failed items:$FAILED, log $LOG\"}}" \
    "$FEISHU_WEBHOOK" >/dev/null 2>&1 || true
}

{
  echo "=== $(date "+%F %T") backup start ==="

  # --- 1) MySQL dump(带时间戳,本地保留 14 份) ---
  mkdir -p "$PROJECT/backups/db"
  DBFILE="$PROJECT/backups/db/live-training-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  if docker exec live-training-mysql-1 sh -c \
      "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysqldump -ulive --single-transaction --no-tablespaces live_training" \
      | gzip > "$DBFILE" && [ -s "$DBFILE" ]; then
    echo "db dump ok: $DBFILE ($(du -h "$DBFILE" | cut -f1))"
    ls -t "$PROJECT"/backups/db/live-training-*.sql.gz | tail -n +15 | xargs -r rm --
  else
    rm -f "$DBFILE"
    FAILED="$FAILED mysqldump"
    echo "db dump FAILED"
  fi

  # --- 2) 商品图 copy-only(正本 MinIO,量小增量快) ---
  rclone copy minio:product-images oracle:live-recordings/backup/product-images --transfers 2 --log-level INFO
  rc=$?; echo "product-images rc=$rc"
  [ "$rc" -eq 0 ] || FAILED="$FAILED product-images"

  # --- 3) DB 备份上桶(按时间戳独立文件,永不覆盖历史) ---
  rclone copy "$PROJECT/backups/db" oracle:live-recordings/backup/mysql --transfers 2 --log-level INFO
  rc=$?; echo "db-upload rc=$rc"
  [ "$rc" -eq 0 ] || FAILED="$FAILED db-upload"

  # --- 4) 桶内滚动清理:删除 14 天前的 mysql 备份 ---
  rclone delete oracle:live-recordings/backup/mysql --min-age 336h --log-level INFO
  rc=$?; echo "rotate rc=$rc"
  [ "$rc" -eq 0 ] || FAILED="$FAILED rotate"

  # --- 5) 结果与告警 ---
  if [ -n "$FAILED" ]; then
    echo "FAILED:$FAILED"
    alert
  else
    echo "all steps ok"
  fi
  echo "=== $(date "+%F %T") backup end ==="
} >> "$LOG" 2>&1
