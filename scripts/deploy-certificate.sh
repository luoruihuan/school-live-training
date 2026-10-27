#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${RENEWED_LINEAGE:?此脚本由 Certbot deploy-hook 调用，需提供 RENEWED_LINEAGE}"
test -s "$RENEWED_LINEAGE/fullchain.pem"
test -s "$RENEWED_LINEAGE/privkey.pem"
openssl x509 -in "$RENEWED_LINEAGE/fullchain.pem" -noout -checkend 0
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"
install -d -m 0700 deploy/tls
install -m 0644 "$RENEWED_LINEAGE/fullchain.pem" deploy/tls/fullchain.pem
install -m 0600 "$RENEWED_LINEAGE/privkey.pem" deploy/tls/privkey.pem
docker compose --env-file deploy/.env -f compose.production.yaml exec -T web nginx -t </dev/null
docker compose --env-file deploy/.env -f compose.production.yaml exec -T web nginx -s reload </dev/null
