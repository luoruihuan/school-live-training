#!/bin/bash
# 每日备份(root crontab 03:15)→ 甲骨文对象存储桶 live-recordings
# 架构定位:回放正本在腾讯 COS 不做副本;本脚本负责数据库+商品图的异地(异厂商)备份。
# 1) MySQL dump → 本地 backups/db/(保留最近14份)→ oracle backup/mysql/(保留最近14份)
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
    -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"[backup fail] Shanghai daily backup-to-oracle failed items:$FAILED, log $LOG\"}}" \
    "$FEISHU_WEBHOOK" >/dev/null 2>&1 || true
}

{
  echo "=== $(date "+%F %T") backup start ==="

  # --- 1) MySQL dump(内容未变化时不生成新的备份文件) ---
  DB_DIR="$PROJECT/backups/db"
  DB_STATE="$DB_DIR/.live-training-last-sha256"
  REMOTE_DB="oracle:live-recordings/backup/mysql"
  mkdir -p "$DB_DIR"
  DB_TMP="$DB_DIR/.live-training-$(date -u +%Y%m%dT%H%M%SZ).sql"
  DB_HASH_PENDING=""

  if docker exec live-training-mysql-1 sh -c \
      "MYSQL_PWD=\"\$MYSQL_PASSWORD\" mysqldump -ulive --single-transaction --no-tablespaces live_training" \
      > "$DB_TMP" && [ -s "$DB_TMP" ]; then
    DB_HASH="$(sed '/^-- Dump completed on /d' "$DB_TMP" | sha256sum | awk '{print $1}')"
    PREVIOUS_HASH="$(cat "$DB_STATE" 2>/dev/null || true)"

    if [ "$DB_HASH" = "$PREVIOUS_HASH" ]; then
      rm -f "$DB_TMP"
      echo "db unchanged: sha256=$DB_HASH, new backup skipped"
    else
      DBFILE="$DB_DIR/live-training-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
      if gzip -c "$DB_TMP" > "$DBFILE" && [ -s "$DBFILE" ]; then
        echo "db dump ok: $DBFILE ($(du -h "$DBFILE" | cut -f1), sha256=$DB_HASH)"
        ls -t "$DB_DIR"/live-training-*.sql.gz | tail -n +15 | xargs -r rm --
        DB_HASH_PENDING="$DB_HASH"
      else
        rm -f "$DBFILE"
        FAILED="$FAILED mysqldump"
        echo "db dump FAILED"
      fi
      rm -f "$DB_TMP"
    fi
  else
    rm -f "$DB_TMP"
    FAILED="$FAILED mysqldump"
    echo "db dump FAILED"
  fi

  # --- 2) 商品图 copy-only(正本 MinIO,量小增量快) ---
  rclone copy minio:product-images oracle:live-recordings/backup/product-images --transfers 2 --log-level INFO
  rc=$?; echo "product-images rc=$rc"
  [ "$rc" -eq 0 ] || FAILED="$FAILED product-images"

  # --- 3) DB 备份上桶(只同步内容有变化的新文件,同时校验远端已有文件) ---
  rclone copy "$DB_DIR" "$REMOTE_DB" --include 'live-training-*.sql.gz' --transfers 2 --log-level INFO
  rc=$?; echo "db-upload rc=$rc"
  if [ "$rc" -eq 0 ] && [ -n "$DB_HASH_PENDING" ]; then
    printf '%s\n' "$DB_HASH_PENDING" > "$DB_STATE"
  fi
  [ "$rc" -eq 0 ] || FAILED="$FAILED db-upload"

  # --- 4) 桶内滚动清理:保留最新 14 个 DB 备份,即使长期没有新数据也保留最后一份 ---
  REMOTE_FILES="$(rclone lsf "$REMOTE_DB" --files-only --include 'live-training-*.sql.gz' --log-level INFO)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    REMOTE_FILES="$(printf '%s\n' "$REMOTE_FILES" | sort)"
    REMOTE_BACKUPS=()
    if [ -n "$REMOTE_FILES" ]; then
      while IFS= read -r REMOTE_FILE; do
        [ -n "$REMOTE_FILE" ] && REMOTE_BACKUPS+=("$REMOTE_FILE")
      done <<EOF
$REMOTE_FILES
EOF
    fi
    KEEP_COUNT=14
    DELETE_COUNT=$(( ${#REMOTE_BACKUPS[@]} - KEEP_COUNT ))
    if [ "$DELETE_COUNT" -gt 0 ]; then
      for REMOTE_FILE in "${REMOTE_BACKUPS[@]:0:DELETE_COUNT}"; do
        rclone deletefile "$REMOTE_DB/$REMOTE_FILE" --log-level INFO || rc=$?
      done
    fi
  fi
  echo "rotate rc=$rc"
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
