#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"
mkdir -p backups
backup_file="$(mktemp "$project_dir/backups/live-training-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.sql.partial")"
trap 'rm -f "$backup_file"' EXIT
docker compose --env-file deploy/.env -f compose.production.yaml exec -T mysql \
  sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump -ulive --single-transaction --no-tablespaces --set-gtid-purged=OFF live_training' > "$backup_file"
test -s "$backup_file"
mv "$backup_file" "${backup_file%.partial}"
printf '备份已生成：%s\n' "${backup_file%.partial}"
