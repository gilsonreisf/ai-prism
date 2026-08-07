#!/usr/bin/env bash
set -euo pipefail

# Homebrew keeps versioned PostgreSQL formulae keg-only. Prefer 17 because the
# pgvector bottle ships its extension for PostgreSQL 17/18.
if [ -d /opt/homebrew/opt/postgresql@17/bin ]; then
  export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_DIR="$ROOT_DIR/.local"
DATA_DIR="$LOCAL_DIR/postgres"
LOG_FILE="$LOCAL_DIR/postgres.log"
PORT=55432
USER_NAME=ai_prism
DB_NAME=ai_prism

need_postgres() {
  for cmd in initdb pg_ctl psql createdb; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "PostgreSQL 16 não encontrado. Instale apenas o pacote leve: brew install postgresql@16" >&2
      exit 1
    fi
  done
}

is_running() {
  [ -f "$DATA_DIR/PG_VERSION" ] && pg_ctl -D "$DATA_DIR" status >/dev/null 2>&1
}

start_db() {
  need_postgres
  mkdir -p "$LOCAL_DIR"
  if [ ! -f "$DATA_DIR/PG_VERSION" ]; then
    echo "Inicializando Postgres local em .local/postgres…"
    # mmap also works in restricted shells/CI where System V shared memory is
    # unavailable; initdb persists both settings in postgresql.conf.
    initdb -D "$DATA_DIR" -U "$USER_NAME" --auth=trust --no-locale -E UTF8 \
      -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap >/dev/null
  fi
  if ! is_running; then
    pg_ctl -D "$DATA_DIR" -l "$LOG_FILE" -o "-p $PORT -h 127.0.0.1" start -w >/dev/null
  fi
  if [ "$(psql -h 127.0.0.1 -p "$PORT" -U "$USER_NAME" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")" != "1" ]; then
    createdb -h 127.0.0.1 -p "$PORT" -U "$USER_NAME" "$DB_NAME"
  fi
  echo "Postgres local pronto em 127.0.0.1:$PORT/$DB_NAME"
}

stop_db() {
  need_postgres
  if is_running; then
    pg_ctl -D "$DATA_DIR" stop -m fast -w >/dev/null
    echo "Postgres local parado; dados preservados."
  else
    echo "Postgres local já está parado."
  fi
}

case "${1:-}" in
  up) start_db ;;
  down) stop_db ;;
  status)
    need_postgres
    if is_running; then echo "Postgres local está ativo em 127.0.0.1:$PORT"; else echo "Postgres local está parado"; exit 1; fi
    ;;
  reset)
    stop_db
    if [ -d "$DATA_DIR" ]; then
      BACKUP_DIR="$LOCAL_DIR/postgres.backup.$(date +%Y%m%d%H%M%S)"
      mv "$DATA_DIR" "$BACKUP_DIR"
      echo "Dados anteriores movidos para ${BACKUP_DIR#$ROOT_DIR/}. Rode local:up para um banco vazio."
    fi
    ;;
  *) echo "Uso: $0 {up|down|status|reset}" >&2; exit 2 ;;
esac
