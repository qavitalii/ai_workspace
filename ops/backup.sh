#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo 'Install the application first.'; exit 1; }
set -a; source .env; set +a
umask 077
mkdir -p backups
[[ -f .backup-key ]] || openssl rand -hex 32 > .backup-key
work=$(mktemp -d)
restart=0
cleanup(){ rm -rf "$work"; if [[ "$restart" == 1 ]]; then ./ops/compose.sh start server >/dev/null; fi; }
trap cleanup EXIT
# Stop writers for a consistent DB/files checkpoint. Running jobs become interrupted on recovery.
./ops/compose.sh stop server; restart=1
./ops/compose.sh exec -T db pg_dump -U workspace -d workspace -Fc > "$work/database.dump"
cp .env "$work/env"
cp .install-mode "$work/install-mode"
tar -C "$DATA_ROOT" -czf "$work/data.tar.gz" .
archive="backups/workspace-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.enc"
tar -C "$work" -czf - . | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass file:.backup-key -out "$archive"
find backups -name 'workspace-*.tar.gz.enc' -mtime +7 -delete
printf 'Saved encrypted backup: %s\nKeep .backup-key separately; this server alone is not an offsite backup.\n' "$archive"
