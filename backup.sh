#!/usr/bin/env bash
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR}/backups"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

DB_CONTAINER="striderforge-db"
DB_USER="${POSTGRES_USER:-striderforge}"
DB_NAME="${POSTGRES_DB:-striderforge}"

MAX_BACKUPS="${MAX_BACKUPS:-30}"

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[BACKUP]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# ─── Helpers ─────────────────────────────────────────────────────────────────
check_container_running() {
  if ! docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
    error "Container '${DB_CONTAINER}' is not running."
    error "Start it with: docker compose -f ${COMPOSE_FILE} up -d"
    exit 1
  fi
}

load_env() {
  local env_file="${SCRIPT_DIR}/.env"
  if [[ -f "$env_file" ]]; then
    set -a
    source "$env_file"
    set +a
    DB_USER="${POSTGRES_USER:-striderforge}"
    DB_NAME="${POSTGRES_DB:-striderforge}"
  fi
}

# ─── Backup ──────────────────────────────────────────────────────────────────
do_backup() {
  local timestamp
  timestamp="$(date +%Y%m%d_%H%M%S)"
  local backup_subdir="${BACKUP_DIR}/${timestamp}"

  mkdir -p "$backup_subdir"

  check_container_running

  # 1) PostgreSQL dump (custom format for efficient restore)
  log "Dumping PostgreSQL database '${DB_NAME}'..."
  docker exec "${DB_CONTAINER}" \
    pg_dump -U "${DB_USER}" -d "${DB_NAME}" -Fc --clean --if-exists \
    > "${backup_subdir}/database.dump"
  log "Database dump complete."

  # 2) Also create a plain SQL dump (human-readable, useful for inspection)
  log "Creating plain SQL dump..."
  docker exec "${DB_CONTAINER}" \
    pg_dump -U "${DB_USER}" -d "${DB_NAME}" --clean --if-exists \
    > "${backup_subdir}/database.sql"
  log "SQL dump complete."

  # 3) Backup card-images volume
  log "Backing up card-images volume..."
  docker run --rm \
    -v "$(docker compose -f "${COMPOSE_FILE}" config --format json 2>/dev/null | \
         python3 -c "import sys,json; vs=json.load(sys.stdin).get('volumes',{}); print(list(vs.keys())[1] if len(vs)>1 else 'backend_card-images')" 2>/dev/null || echo "backend_card-images"):/source:ro" \
    -v "${backup_subdir}:/backup" \
    alpine tar czf /backup/card-images.tar.gz -C /source . 2>/dev/null || {
    # Fallback: use the full volume name from docker
    local volume_prefix
    volume_prefix="$(basename "${SCRIPT_DIR}")"
    docker run --rm \
      -v "${volume_prefix}_card-images:/source:ro" \
      -v "${backup_subdir}:/backup" \
      alpine tar czf /backup/card-images.tar.gz -C /source . 2>/dev/null || {
      warn "Could not backup card-images volume (may be empty or volume name differs)."
      warn "Check volume name with: docker volume ls | grep card-images"
    }
  }

  # 4) Backup uploads volume
  log "Backing up uploads volume..."
  docker run --rm \
    -v "$(docker compose -f "${COMPOSE_FILE}" config --format json 2>/dev/null | \
         python3 -c "import sys,json; vs=json.load(sys.stdin).get('volumes',{}); print(list(vs.keys())[2] if len(vs)>2 else 'backend_uploads')" 2>/dev/null || echo "backend_uploads"):/source:ro" \
    -v "${backup_subdir}:/backup" \
    alpine tar czf /backup/uploads.tar.gz -C /source . 2>/dev/null || {
    local volume_prefix
    volume_prefix="$(basename "${SCRIPT_DIR}")"
    docker run --rm \
      -v "${volume_prefix}_uploads:/source:ro" \
      -v "${backup_subdir}:/backup" \
      alpine tar czf /backup/uploads.tar.gz -C /source . 2>/dev/null || {
      warn "Could not backup uploads volume (may be empty or volume name differs)."
      warn "Check volume name with: docker volume ls | grep uploads"
    }
  }

  # 5) Backup custom-cards volume
  log "Backing up custom-cards volume..."
  local volume_prefix
  volume_prefix="$(basename "${SCRIPT_DIR}")"
  docker run --rm \
    -v "${volume_prefix}_custom-cards:/source:ro" \
    -v "${backup_subdir}:/backup" \
    alpine tar czf /backup/custom-cards.tar.gz -C /source . 2>/dev/null || {
    warn "Could not backup custom-cards volume (may be empty or volume name differs)."
    warn "Check volume name with: docker volume ls | grep custom-cards"
  }

  # 6) Write metadata
  cat > "${backup_subdir}/metadata.json" <<METAEOF
{
  "timestamp": "${timestamp}",
  "date": "$(date -Iseconds)",
  "database": "${DB_NAME}",
  "user": "${DB_USER}",
  "container": "${DB_CONTAINER}",
  "files": [
    "database.dump",
    "database.sql",
    "card-images.tar.gz",
    "uploads.tar.gz",
    "custom-cards.tar.gz"
  ]
}
METAEOF

  # 7) Prune old backups
  local backup_count
  backup_count=$(find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d | wc -l)
  if (( backup_count > MAX_BACKUPS )); then
    local to_remove=$(( backup_count - MAX_BACKUPS ))
    log "Pruning ${to_remove} old backup(s) (keeping ${MAX_BACKUPS})..."
    find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d | sort | head -n "${to_remove}" | while read -r dir; do
      rm -rf "$dir"
      log "  Removed $(basename "$dir")"
    done
  fi

  log "${CYAN}Backup complete!${NC}"
  log "Location: ${backup_subdir}"
  du -sh "${backup_subdir}" | awk '{print "  Total size: " $1}'
  echo ""
  ls -lh "${backup_subdir}/"
}

# ─── Restore ─────────────────────────────────────────────────────────────────
do_restore() {
  local backup_path="$1"

  # Accept either a directory or a specific .dump file
  if [[ -f "$backup_path" && "$backup_path" == *.dump ]]; then
    backup_path="$(dirname "$backup_path")"
  fi

  if [[ ! -d "$backup_path" ]]; then
    # Try as a timestamp relative to BACKUP_DIR
    if [[ -d "${BACKUP_DIR}/${backup_path}" ]]; then
      backup_path="${BACKUP_DIR}/${backup_path}"
    else
      error "Backup not found: ${backup_path}"
      error "Usage: $0 --restore <backup_dir_or_timestamp>"
      list_backups
      exit 1
    fi
  fi

  local dump_file="${backup_path}/database.dump"
  if [[ ! -f "$dump_file" ]]; then
    error "No database.dump found in ${backup_path}"
    exit 1
  fi

  check_container_running

  echo ""
  warn "This will OVERWRITE the current database '${DB_NAME}' with the backup from:"
  warn "  ${backup_path}"
  echo ""

  if [[ "${FORCE_RESTORE:-}" != "true" ]]; then
    read -rp "Are you sure? (y/N): " confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
      log "Restore cancelled."
      exit 0
    fi
  fi

  # 1) Restore database
  log "Restoring database from dump..."
  docker exec -i "${DB_CONTAINER}" \
    pg_restore -U "${DB_USER}" -d "${DB_NAME}" --clean --if-exists --no-owner --no-privileges \
    < "$dump_file" 2>&1 || {
    warn "pg_restore reported warnings (this is normal for --clean on a fresh DB)."
  }
  log "Database restore complete."

  # 2) Restore card-images volume
  local card_images_archive="${backup_path}/card-images.tar.gz"
  if [[ -f "$card_images_archive" ]]; then
    log "Restoring card-images volume..."
    local volume_prefix
    volume_prefix="$(basename "${SCRIPT_DIR}")"
    docker run --rm \
      -v "${volume_prefix}_card-images:/target" \
      -v "${backup_path}:/backup:ro" \
      alpine sh -c "rm -rf /target/* && tar xzf /backup/card-images.tar.gz -C /target" 2>/dev/null || {
      warn "Could not restore card-images volume. You may need to restore manually."
    }
  else
    warn "No card-images.tar.gz found, skipping volume restore."
  fi

  # 3) Restore uploads volume
  local uploads_archive="${backup_path}/uploads.tar.gz"
  if [[ -f "$uploads_archive" ]]; then
    log "Restoring uploads volume..."
    local volume_prefix
    volume_prefix="$(basename "${SCRIPT_DIR}")"
    docker run --rm \
      -v "${volume_prefix}_uploads:/target" \
      -v "${backup_path}:/backup:ro" \
      alpine sh -c "rm -rf /target/* && tar xzf /backup/uploads.tar.gz -C /target" 2>/dev/null || {
      warn "Could not restore uploads volume. You may need to restore manually."
    }
  else
    warn "No uploads.tar.gz found, skipping volume restore."
  fi

  # 4) Restore custom-cards volume
  local custom_cards_archive="${backup_path}/custom-cards.tar.gz"
  if [[ -f "$custom_cards_archive" ]]; then
    log "Restoring custom-cards volume..."
    local volume_prefix
    volume_prefix="$(basename "${SCRIPT_DIR}")"
    docker run --rm \
      -v "${volume_prefix}_custom-cards:/target" \
      -v "${backup_path}:/backup:ro" \
      alpine sh -c "rm -rf /target/* && tar xzf /backup/custom-cards.tar.gz -C /target" 2>/dev/null || {
      warn "Could not restore custom-cards volume. You may need to restore manually."
    }
  else
    warn "No custom-cards.tar.gz found, skipping volume restore."
  fi

  log "${GREEN}Restore complete!${NC}"
  log "You may want to restart the API container: docker compose -f ${COMPOSE_FILE} restart api"
}

# ─── List ────────────────────────────────────────────────────────────────────
list_backups() {
  echo ""
  log "Available backups:"
  echo ""

  if [[ ! -d "$BACKUP_DIR" ]] || [[ -z "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]]; then
    warn "No backups found in ${BACKUP_DIR}"
    return
  fi

  printf "  %-20s %-10s %s\n" "TIMESTAMP" "SIZE" "PATH"
  printf "  %-20s %-10s %s\n" "---------" "----" "----"

  for dir in "${BACKUP_DIR}"/*/; do
    [[ -d "$dir" ]] || continue
    local name size
    name="$(basename "$dir")"
    size="$(du -sh "$dir" 2>/dev/null | awk '{print $1}')"
    printf "  %-20s %-10s %s\n" "$name" "$size" "$dir"
  done
  echo ""
}

# ─── Usage ───────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF

${CYAN}StridersForge Database Backup & Restore${NC}

Usage:
  $0 --backup                     Create a new backup
  $0 --restore <path|timestamp>   Restore from a backup
  $0 --list                       List all available backups
  $0 --help                       Show this help

Options:
  MAX_BACKUPS=30    Max backups to keep (older are pruned)
  FORCE_RESTORE=true  Skip confirmation prompt on restore

Examples:
  $0 --backup
  $0 --restore 20260605_093000
  $0 --restore ./backups/20260605_093000
  $0 --list

Cron (daily at 2 AM):
  0 2 * * * cd /path/to/backend && ./backup.sh --backup >> /var/log/striderforge-backup.log 2>&1

EOF
}

# ─── Main ────────────────────────────────────────────────────────────────────
load_env

case "${1:-}" in
  --backup|-b)
    do_backup
    ;;
  --restore|-r)
    if [[ -z "${2:-}" ]]; then
      error "Please specify a backup to restore from."
      list_backups
      exit 1
    fi
    do_restore "$2"
    ;;
  --list|-l)
    list_backups
    ;;
  --help|-h|"")
    usage
    ;;
  *)
    error "Unknown option: $1"
    usage
    exit 1
    ;;
esac
