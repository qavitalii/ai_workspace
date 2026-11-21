#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source ./ops/maintenance-lock.sh
[[ $# == 2 && "$2" == --replace-existing ]] || { echo 'Usage: ./ops/restore.sh /path/backup.tar.gz.enc --replace-existing'; exit 1; }
[[ -f .backup-key ]] || { echo 'Restore the original .backup-key first.'; exit 1; }
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:.backup-key -in "$1" | tar -xz -C "$work"
./ops/compose.sh down
# Preserve existing local path and DB password for the existing database volume.
set -a; source .env; set +a
old_data="$DATA_ROOT"; old_db_password="$POSTGRES_PASSWORD"
cp .env .env.before-restore
cp "$work/env" .env
RESTORE_DATA_ROOT="$old_data" RESTORE_DB_PASSWORD="$old_db_password" python3 - <<'PY'
import os
p='.env'; s=open(p).read().splitlines(); values={'DATA_ROOT':os.environ['RESTORE_DATA_ROOT'],'POSTGRES_PASSWORD':os.environ['RESTORE_DB_PASSWORD']}
open(p,'w').write('\n'.join(k+'='+values.get(k,v) for k,v in (l.split('=',1) for l in s if '=' in l))+'\n')
PY
set -a; source .env; set +a
mv "$DATA_ROOT" "$DATA_ROOT.before-restore-$(date +%s)"
mkdir -p "$DATA_ROOT"; chmod 700 "$DATA_ROOT"
tar -xzf "$work/data.tar.gz" -C "$DATA_ROOT"
./ops/compose.sh up -d --wait db
# Archives from before project packages cannot remove the newer table's foreign keys.
# Commit the cleanup and restore together, only after pg_restore has emitted all SQL.
{
  printf 'BEGIN;\nDROP TABLE IF EXISTS public.project_packages;\n'
  ./ops/compose.sh exec -T db pg_restore --clean --if-exists --no-owner --file=- < "$work/database.dump" &&
    printf '\nCOMMIT;\n'
} | ./ops/compose.sh exec -T db psql -X -q -v ON_ERROR_STOP=1 -U workspace -d workspace
./ops/compose.sh up -d --wait server caddy
echo 'Restored. Inspect interrupted jobs before continuing. Remove retained pre-restore files only after verification.'
