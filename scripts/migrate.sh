#!/usr/bin/env bash
# Apply every migration in order. Idempotent per-database via schema_migrations.
set -euo pipefail

DB_URL="${DATABASE_URL:-postgres://app:app@127.0.0.1:5432/wafilter_dev}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/db/migrations"

psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c \
  'create table if not exists public.schema_migrations (version text primary key, applied_at timestamptz not null default now())'

for f in "$DIR"/*.sql; do
  version="$(basename "$f" .sql)"
  applied="$(psql "$DB_URL" -tAc "select 1 from public.schema_migrations where version = '$version'")"
  if [ "$applied" = "1" ]; then
    echo "  = $version"
    continue
  fi
  echo "  + $version"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q --single-transaction \
    -f "$f" \
    -c "insert into public.schema_migrations (version) values ('$version')"
done
echo "migrations up to date"
